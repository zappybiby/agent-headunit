"""Build a contact sheet from a finished agent-device MP4 using FFmpeg and Pillow."""

import argparse
from contextlib import suppress
from dataclasses import dataclass
from fractions import Fraction
from io import BytesIO
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from tempfile import NamedTemporaryFile
from time import monotonic


SAMPLE_INTERVAL_MS = 250
MAX_SAMPLES = 48
MAX_CELLS = 24
CELL_WIDTHS = (360, 320, 280, 240, 200, 160)
DEFAULT_THRESHOLD = 0.02
DEFAULT_MAX_PIXELS = 20_000_000
EXTRACTION_TIMEOUT = 90


class ContactSheetError(RuntimeError):
    def __init__(self, reason, message, *, code="COMMAND_FAILED", **details):
        super().__init__(message)
        self.code = code
        self.details = {"reason": f"contact_sheet_{reason}", **details}


@dataclass(frozen=True)
class Timeline:
    time_base: Fraction
    seek_origin: Fraction


def rounded(value):
    return math.floor(value + 0.5)


def sample_times(duration_ms):
    if duration_ms <= SAMPLE_INTERVAL_MS:
        return [0, duration_ms] if duration_ms else [0]
    count = min(MAX_SAMPLES, duration_ms // SAMPLE_INTERVAL_MS + 1)
    return [rounded(index * duration_ms / (count - 1)) for index in range(count)]


def mp4_boxes(handle, start, end):
    while start + 8 <= end:
        handle.seek(start)
        header = handle.read(8)
        if len(header) != 8:
            break
        size, kind = struct.unpack(">I4s", header)
        payload = start + 8
        if size == 1:
            extended_size = handle.read(8)
            if len(extended_size) != 8:
                break
            size = int.from_bytes(extended_size, "big")
            payload += 8
        box_end = start + size if size else end
        if box_end < payload or box_end > end:
            break
        yield kind, payload, box_end
        start = box_end


def movie_duration(video):
    duration = None
    container = "unknown"
    if video.is_file():
        with suppress(OSError), video.open("rb") as handle:
            if handle.read(4) == b"\x1a\x45\xdf\xa3" and video.suffix.lower() == ".webm":
                container = "webm"
            boxes = {}
            for kind, start, end in mp4_boxes(handle, 0, os.fstat(handle.fileno()).st_size):
                if kind in (b"ftyp", b"moov"):
                    boxes.setdefault(kind, (start, end))
                if len(boxes) == 2:
                    break
            if len(boxes) == 2:
                container = "mp4"
                for kind, start, end in mp4_boxes(handle, *boxes[b"moov"]):
                    if kind == b"mvhd" and end - start >= 32:
                        handle.seek(start)
                        movie_header = handle.read(32)
                        if len(movie_header) == 32:
                            duration = read_movie_header(movie_header)
                        break
    if container != "mp4":
        description = "is WebM" if container == "webm" else "is not a readable MP4"
        raise ContactSheetError("container_unsupported", f"Contact sheets need an MP4 recording. {video} {description}.",
                                code="INVALID_ARGS", videoPath=str(video), container=container)
    if duration is None:
        raise ContactSheetError("duration_unknown", f"Could not read the video timeline of {video}.", videoPath=str(video))
    return duration


def read_movie_header(header):
    version = header[0]
    if version == 0:
        timescale, duration = struct.unpack_from(">II", header, 12)
        if duration == 0xffffffff:
            return None
    elif version == 1:
        timescale, duration = struct.unpack_from(">IQ", header, 20)
    else:
        return None
    if timescale and duration <= 2**53 - 1:
        return rounded(duration * 1000 / timescale)


def run_decoder(command, deadline, video):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, check=True,
                                timeout=max(0, deadline - monotonic()))
    except subprocess.TimeoutExpired as error:
        raise ContactSheetError("frame_extraction_failed", "Contact sheet frame extraction timed out.",
                                videoPath=str(video)) from error
    except (OSError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", None) or b""
        lines = stderr.decode("utf-8", "replace").strip().splitlines()
        detail = lines[-1] if lines else str(error)
        raise ContactSheetError("frame_extraction_failed", f"Could not decode the recording. {detail}",
                                videoPath=str(video)) from error
    return result.stdout


def video_timeline(ffprobe, video, deadline):
    command = [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
               "-show_entries", "stream=time_base:format=start_time", "-of", "json", str(video)]
    try:
        report = json.loads(run_decoder(command, deadline, video))
        streams = report.get("streams", [])
        if not streams:
            return None
        start = report.get("format", {}).get("start_time", "0")
        time_base = Fraction(streams[0]["time_base"])
        if time_base > 0:
            return Timeline(time_base=time_base, seek_origin=Fraction(start if start != "N/A" else "0"))
    except (ValueError, KeyError, ZeroDivisionError) as error:
        raise ContactSheetError("frame_extraction_failed", "Could not locate the video stream on the recording timeline.",
                                videoPath=str(video)) from error
    raise ContactSheetError("frame_extraction_failed", "The recording reported an invalid video time base.",
                            videoPath=str(video))


def sample_packet(ffprobe, video, timeline, time_ms, deadline):
    requested = Fraction(time_ms, 1000)
    interval = f"{float(requested):.6f}%{float(requested + Fraction(1, 2)):.6f}"
    command = [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
               "-read_intervals", interval, "-show_entries", "packet=pts,duration", "-of", "csv=p=0", str(video)]
    packets = run_decoder(command, deadline, video).splitlines()
    requested_pts = requested / timeline.time_base
    candidate = None
    for packet in packets:
        pts_value, _, duration_value = packet.partition(b",")
        try:
            pts = int(pts_value)
        except ValueError:
            continue
        if pts <= requested_pts and (candidate is None or candidate[0] < pts):
            duration = int(duration_value) if duration_value.isdigit() else 0
            candidate = (pts, duration)
    if candidate is None:
        return None
    pts, duration = candidate
    actual = pts * timeline.time_base
    if actual < 0 or abs(pts) >= 2**53:
        return None
    if duration > 0 and (pts + duration) * timeline.time_base + Fraction(1, 1000) < requested:
        return None
    return pts, actual


def decode_frame(ffmpeg, video, pts, time, timeline, max_pixels, deadline, image_module):
    seek = max(0, float(time - timeline.seek_origin) - 0.001)
    frame_size = CELL_WIDTHS[0]
    # Keep the source PTS across seeking so the decoded cell carries the selected packet's time.
    filters = (f"select='eq(pts,{pts})',scale='min({frame_size},iw)':'min({frame_size},ih)':"
               "force_original_aspect_ratio=decrease:flags=area,setsar=1")
    command = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file",
               "-ss", f"{seek:.6f}", "-t", "2", "-copyts", "-threads", "2", "-i", str(video),
               "-map", "0:v:0", "-filter_threads", "1", "-vf", filters, "-frames:v", "1", "-an",
               "-c:v", "png", "-threads:v", "1", "-f", "image2pipe", "pipe:1"]
    payload = run_decoder(command, deadline, video)
    if not payload:
        return None
    try:
        with image_module.open(BytesIO(payload), formats=["PNG"]) as image:
            if max(image.size) > frame_size or image.width * image.height > max_pixels:
                raise ContactSheetError("frame_extraction_failed", "A decoded frame exceeded the contact sheet pixel budget.",
                                        videoPath=str(video), maxPixels=max_pixels)
            return image.convert("RGB")
    except OSError as error:
        raise ContactSheetError("frame_extraction_failed", "FFmpeg returned an unreadable recording frame.",
                                videoPath=str(video)) from error


def extract_frames(video, times, max_pixels, ffprobe, ffmpeg, image_module):
    deadline = monotonic() + EXTRACTION_TIMEOUT
    timeline = video_timeline(ffprobe, video, deadline)
    frames = []
    decoded = {}
    if timeline:
        for time_ms in times:
            packet = sample_packet(ffprobe, video, timeline, time_ms, deadline)
            if packet is None:
                continue
            pts, actual = packet
            if pts not in decoded:
                decoded[pts] = decode_frame(ffmpeg, video, pts, actual, timeline, max_pixels, deadline, image_module)
            if decoded[pts] is not None:
                frames.append((float(actual * 1000), decoded[pts]))
    if not frames:
        raise ContactSheetError("no_frames", "The recording returned no decodable frames for a contact sheet.",
                                videoPath=str(video), skippedSampleCount=len(times))
    return sorted(frames, key=lambda sample: sample[0])


def changed_ratio(baseline, image, image_chops):
    if baseline is None or baseline.size != image.size:
        return 1
    red, green, blue = image_chops.difference(baseline, image).split()
    difference = image_chops.lighter(image_chops.lighter(red, green), blue)
    pixels = image.width * image.height
    return (pixels - difference.histogram()[0]) / pixels


def pick_cells(frames, threshold, image_chops):
    cells = []
    baseline = None
    for time_ms, image in frames:
        ratio = changed_ratio(baseline, image, image_chops)
        if ratio >= threshold:
            cells.append((time_ms, ratio, image))
            baseline = image
    last_time, last_image = frames[-1]
    if cells[-1][0] != last_time:
        cells.append((last_time, changed_ratio(baseline, last_image, image_chops), last_image))
    kept = len(cells)
    if kept > MAX_CELLS:
        cells = [cells[rounded(index * (kept - 1) / (MAX_CELLS - 1))] for index in range(MAX_CELLS)]
    return cells, kept


def timestamp(time_ms):
    seconds, milliseconds = divmod(math.floor(time_ms), 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def render_grid(cells, max_pixels, image_module, image_draw, image_font):
    padding, gap, label_height = 8, 8, 22
    columns = min(4, len(cells))
    rows = math.ceil(len(cells) / columns)
    first = cells[0][2]
    for cell_width in CELL_WIDTHS:
        cell_height = max(1, rounded(cell_width * first.height / first.width))
        width = 2 * padding + columns * cell_width + (columns - 1) * gap
        height = 2 * padding + rows * (cell_height + label_height) + (rows - 1) * gap
        if width * height <= max_pixels:
            break
    else:
        raise ContactSheetError("pixel_budget_exceeded", f"The contact sheet exceeds the {max_pixels:,} pixel limit.",
                                cellCount=len(cells), maxPixels=max_pixels)

    sheet = image_module.new("RGB", (width, height), "#111827")
    draw = image_draw.Draw(sheet)
    font = image_font.load_default(size=14)
    for index, (time_ms, _, image) in enumerate(cells):
        row, column = divmod(index, columns)
        x = padding + column * (cell_width + gap)
        y = padding + row * (cell_height + label_height + gap)
        draw.text((x + 4, y + 4), timestamp(time_ms), fill="white", font=font, anchor="lt")
        sheet.paste(image.resize((cell_width, cell_height), image_module.Resampling.BOX), (x, y + label_height))
    return sheet


def assert_output_safe(video, output):
    collision = video == output
    with suppress(OSError):
        collision = collision or video.samefile(output)
    if collision:
        raise ContactSheetError("output_collides_with_input", f"The contact sheet cannot replace its recording. {output}",
                                code="INVALID_ARGS", videoPath=str(video), outputPath=str(output))


def publish_grid(sheet, video, output):
    temp = None
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(prefix=".contact-sheet-", suffix=".png", dir=output.parent, delete=False) as handle:
            temp = Path(handle.name)
            sheet.save(handle, format="PNG")
        assert_output_safe(video, output)
        os.replace(temp, output)
    except OSError as error:
        raise ContactSheetError("output_write_failed", f"Could not write the contact sheet to {output}. {error}",
                                outputPath=str(output)) from error
    finally:
        if temp is not None:
            with suppress(OSError):
                temp.unlink(missing_ok=True)


def build_contact_sheet(video, output=None, *, changed_pixel_threshold=DEFAULT_THRESHOLD, max_pixels=DEFAULT_MAX_PIXELS):
    if not math.isfinite(changed_pixel_threshold) or not 0 <= changed_pixel_threshold <= 1:
        raise ContactSheetError("threshold_invalid", "The changed pixel threshold must be between 0 and 1.",
                                code="INVALID_ARGS")
    video = Path(os.path.abspath(Path(video).expanduser()))
    output = (Path(os.path.abspath(Path(output).expanduser())) if output is not None else
              video.with_name(video.stem + ".contact-sheet.png"))
    assert_output_safe(video, output)
    duration = movie_duration(video)
    ffprobe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise ContactSheetError("unsupported_host", "Add FFmpeg and FFprobe to PATH to make a contact sheet.",
                                code="UNSUPPORTED_OPERATION")
    try:
        from PIL import Image, ImageChops, ImageDraw, ImageFont
    except ImportError as error:
        raise ContactSheetError("unsupported_host", "Install Pillow to make a contact sheet.",
                                code="UNSUPPORTED_OPERATION") from error

    times = sample_times(duration)
    frames = extract_frames(video, times, max_pixels, ffprobe, ffmpeg, Image)
    cells, kept = pick_cells(frames, changed_pixel_threshold, ImageChops)
    sheet = render_grid(cells, max_pixels, Image, ImageDraw, ImageFont)
    publish_grid(sheet, video, output)

    skipped = len(times) - len(frames)
    report = {
        "path": str(output), "videoPath": str(video), "durationMs": duration,
        "width": sheet.width, "height": sheet.height,
        "sampledFrameCount": len(times), "decodedFrameCount": len(frames), "skippedSampleCount": skipped,
        "changedPixelThreshold": changed_pixel_threshold,
        "cells": [{"timeMs": time_ms, "changedPixelRatio": ratio} for time_ms, ratio, _ in cells],
    }
    warnings = []
    if skipped:
        warnings.append(f"{skipped} sample times returned no frame, so the sheet covers less of the recording than it asked for.")
    if kept > MAX_CELLS:
        warnings.append(f"{kept} changes were found. The sheet shows {MAX_CELLS} cells spread across the recording.")
    if warnings:
        report["warning"] = " ".join(warnings)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a PNG contact sheet from an exported MP4 recording.")
    parser.add_argument("video", type=Path, help="Exported MP4 recording")
    parser.add_argument("--out", type=Path, help="Output PNG path")
    parser.add_argument("--json", action="store_true", help="Print the contact sheet report as JSON")
    args = parser.parse_args(argv)
    try:
        report = build_contact_sheet(args.video, args.out)
    except ContactSheetError as error:
        if args.json:
            print(json.dumps({"success": False, "error": {"code": error.code, "message": str(error), "details": error.details}}))
        else:
            print(str(error), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"success": True, "data": report}))
    else:
        seconds = report["durationMs"] / 1000
        precision = 0 if seconds.is_integer() else 1
        print(report["path"])
        print(f"{len(report['cells'])} cells over {seconds:.{precision}f}s "
              f"({report['sampledFrameCount']} sample times, {report['decodedFrameCount']} frames decoded)")
        if report.get("warning"):
            print(report["warning"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
