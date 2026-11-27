package headunit.agent;

import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Executes one bounded timeline on a selected Android display. */
public final class ProjectedTouch {
    private static final int MAX_FRAMES = 4096;
    private static final int MAX_EVENTS = 16384;
    private static final int MAX_CONTACTS = 5;
    private static final long MAX_DURATION_MS = 60000;
    private static final int MAX_INPUT_CHARS = 4 * 1024 * 1024;
    private static final Object CANCEL_LOCK = new Object();
    private static volatile boolean canceled;

    private ProjectedTouch() {}

    private static final class Point {
        final int id;
        float x;
        float y;

        Point(int id, float x, float y) { this.id = id; this.x = x; this.y = y; }
    }

    private static final class Event {
        final int id;
        final String phase;
        final float x;
        final float y;

        Event(int id, String phase, float x, float y) {
            this.id = id; this.phase = phase; this.x = x; this.y = y;
        }
    }

    private static final class Frame {
        final long at;
        final List<Event> events;

        Frame(long at, List<Event> events) { this.at = at; this.events = events; }
    }

    private static final class Plan {
        final int displayId;
        final List<Frame> frames;

        Plan(int displayId, List<Frame> frames) { this.displayId = displayId; this.frames = frames; }
    }

    private static long integer(JSONObject object, String key, long min, long max) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid " + key);
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < min || number > max)
            throw new IllegalArgumentException("Invalid " + key);
        return (long) number;
    }

    private static float coordinate(JSONObject object, String key, int bound) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid coordinate");
        double number = ((Number) value).doubleValue();
        float result = (float) number;
        if (!Double.isFinite(number) || number < 0 || number >= bound || !Float.isFinite(result) || result >= bound)
            throw new IllegalArgumentException("Invalid coordinate");
        return result;
    }

    private static Plan parse(String line) throws Exception {
        if (line == null || line.length() > MAX_INPUT_CHARS) throw new IllegalArgumentException("Invalid request");
        JSONObject root = new JSONObject(line);
        int display = (int) integer(root, "displayId", 1, Integer.MAX_VALUE);
        int width = (int) integer(root, "width", 1, 32768);
        int height = (int) integer(root, "height", 1, 32768);
        JSONArray source = root.getJSONArray("frames");
        if (source.length() == 0 || source.length() > MAX_FRAMES) throw new IllegalArgumentException("Invalid frame count");
        List<Frame> frames = new ArrayList<>();
        Map<Integer, Boolean> active = new LinkedHashMap<>();
        long previous = -1;
        int total = 0;
        boolean used = false;
        for (int i = 0; i < source.length(); i++) {
            JSONObject frame = source.getJSONObject(i);
            long at = integer(frame, "atMs", 0, MAX_DURATION_MS);
            if (at < previous) throw new IllegalArgumentException("Frames are out of order");
            previous = at;
            JSONArray input = frame.getJSONArray("events");
            if (input.length() == 0 || (total += input.length()) > MAX_EVENTS)
                throw new IllegalArgumentException("Invalid event count");
            List<Event> events = new ArrayList<>();
            for (int j = 0; j < input.length(); j++) {
                JSONObject item = input.getJSONObject(j);
                int id = (int) integer(item, "id", 0, 31);
                String phase = item.getString("phase");
                float x = coordinate(item, "x", width);
                float y = coordinate(item, "y", height);
                if ("down".equals(phase)) {
                    if (active.containsKey(id) || active.size() >= MAX_CONTACTS)
                        throw new IllegalArgumentException("Invalid pointer down");
                    active.put(id, true);
                    used = true;
                } else if ("up".equals(phase)) {
                    if (active.remove(id) == null) throw new IllegalArgumentException("Invalid pointer up");
                } else if ("move".equals(phase)) {
                    if (!active.containsKey(id)) throw new IllegalArgumentException("Invalid pointer move");
                } else throw new IllegalArgumentException("Invalid pointer phase");
                events.add(new Event(id, phase, x, y));
            }
            frames.add(new Frame(at, events));
        }
        if (!used || !active.isEmpty()) throw new IllegalArgumentException("Incomplete gesture");
        return new Plan(display, frames);
    }

    private static final class Injector {
        final Object manager;
        final Method inject;
        final Method setDisplay;
        final int display;
        final LinkedHashMap<Integer, Point> active = new LinkedHashMap<>();
        long downTime;
        boolean started;

        Injector(int display) throws Exception {
            if (Process.myUid() != 0 || Build.VERSION.SDK_INT < 36 || Build.VERSION.SDK_INT > 37)
                throw new IllegalStateException("Unsupported root or Android version");
            Class<?> inputManager = Class.forName("android.hardware.input.InputManagerGlobal");
            Method getInstance = inputManager.getDeclaredMethod("getInstance");
            getInstance.setAccessible(true);
            manager = getInstance.invoke(null);
            inject = inputManager.getDeclaredMethod("injectInputEvent", InputEvent.class, int.class);
            inject.setAccessible(true);
            setDisplay = InputEvent.class.getDeclaredMethod("setDisplayId", int.class);
            setDisplay.setAccessible(true);
            this.display = display;
        }

        void send(int action, boolean checkCancel) throws Exception {
            if (checkCancel && canceled) throw new InterruptedException("Canceled");
            MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[active.size()];
            MotionEvent.PointerCoords[] coordinates = new MotionEvent.PointerCoords[active.size()];
            int i = 0;
            for (Point point : active.values()) {
                properties[i] = new MotionEvent.PointerProperties();
                properties[i].id = point.id;
                properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
                coordinates[i] = new MotionEvent.PointerCoords();
                coordinates[i].x = point.x; coordinates[i].y = point.y;
                coordinates[i].pressure = 1; coordinates[i].size = 1;
                i++;
            }
            MotionEvent event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                    active.size(), properties, coordinates, 0, 0, 1, 1, 0, 0,
                    InputDevice.SOURCE_TOUCHSCREEN, 0);
            try {
                setDisplay.invoke(event, display);
                if (action == MotionEvent.ACTION_DOWN) started = true;
                if (!Boolean.TRUE.equals(inject.invoke(manager, event, 1)))
                    throw new IllegalStateException("Android rejected input");
                if (action == MotionEvent.ACTION_UP) started = false;
            } finally { event.recycle(); }
        }

        boolean cancel() {
            try {
                if (started && !active.isEmpty()) send(MotionEvent.ACTION_CANCEL, false);
                return true;
            } catch (Exception ignored) {
                return false;
            } finally {
                active.clear();
                started = false;
            }
        }

        void run(Plan plan) throws Exception {
            long start = SystemClock.uptimeMillis();
            for (Frame frame : plan.frames) {
                waitUntil(start + frame.at);
                boolean moved = false;
                Set<Integer> movedIds = new HashSet<>();
                for (Event event : frame.events) {
                    if (moved && (!"move".equals(event.phase) || movedIds.contains(event.id))) {
                        send(MotionEvent.ACTION_MOVE, true);
                        moved = false;
                        movedIds.clear();
                    }
                    if ("down".equals(event.phase)) {
                        if (active.isEmpty()) downTime = SystemClock.uptimeMillis();
                        active.put(event.id, new Point(event.id, event.x, event.y));
                        int action = active.size() == 1 ? MotionEvent.ACTION_DOWN
                                : MotionEvent.ACTION_POINTER_DOWN | ((active.size() - 1) << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
                        send(action, true);
                    } else if ("move".equals(event.phase)) {
                        Point point = active.get(event.id);
                        point.x = event.x; point.y = event.y;
                        moved = true;
                        movedIds.add(event.id);
                    } else {
                        Point point = active.get(event.id);
                        point.x = event.x; point.y = event.y;
                        int index = new ArrayList<>(active.keySet()).indexOf(event.id);
                        int action = active.size() == 1 ? MotionEvent.ACTION_UP
                                : MotionEvent.ACTION_POINTER_UP | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
                        send(action, true);
                        active.remove(event.id);
                    }
                }
                if (moved) send(MotionEvent.ACTION_MOVE, true);
            }
        }
    }

    private static void waitUntil(long target) throws InterruptedException {
        synchronized (CANCEL_LOCK) {
            while (!canceled) {
                long remaining = target - SystemClock.uptimeMillis();
                if (remaining <= 0) return;
                CANCEL_LOCK.wait(remaining);
            }
        }
        throw new InterruptedException("Canceled");
    }

    private static void watchCancel(BufferedReader input) {
        Thread watcher = new Thread(() -> {
            try {
                StringBuilder line = new StringBuilder();
                int character;
                boolean oversized = false;
                while ((character = input.read()) != -1) {
                    if (character == '\n') {
                        if (!oversized && "cancel".contentEquals(line)) break;
                        line.setLength(0);
                        oversized = false;
                    } else if (line.length() < 6) {
                        line.append((char) character);
                    } else oversized = true;
                }
            } catch (Exception ignored) { }
            synchronized (CANCEL_LOCK) { canceled = true; CANCEL_LOCK.notifyAll(); }
        }, "projected-touch-cancel");
        watcher.setDaemon(true);
        watcher.start();
    }

    private static String readRequest(BufferedReader input) throws Exception {
        StringBuilder result = new StringBuilder();
        int character;
        while ((character = input.read()) != -1 && character != '\n') {
            if (result.length() >= MAX_INPUT_CHARS) throw new IllegalArgumentException("Request too large");
            result.append((char) character);
        }
        if (character == -1) throw new IllegalArgumentException("Incomplete request");
        return result.toString();
    }

    public static void main(String[] args) {
        Injector injector = null;
        String status = "error";
        try {
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            Plan plan = parse(readRequest(input));
            injector = new Injector(plan.displayId);
            watchCancel(input);
            injector.run(plan);
            status = "success";
        } catch (Exception error) {
            boolean cleaned = injector == null || injector.cancel();
            if (canceled && cleaned) status = "canceled";
        }
        System.out.println("{\"status\":\"" + status + "\"}");
    }
}
