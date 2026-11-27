"use strict";

function attachControlIcons(rows) {
  const owners = [], captions = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const owner = row.clickable || (row.actions & 16) ? i : owners[row.parent];
    owners.push(owner);
    if (owner === undefined || row.password) continue;
    if (!captions.has(owner)) captions.set(owner, new Set());
    for (const label of [row.text, row.description]) if (label) captions.get(owner).add(label);
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.imageTitles) continue;
    const matches = [...row.imageTitles].filter(title => captions.get(owners[i])?.has(title));
    if (matches.length === 1) row.imageItemTitle = matches[0];
    delete row.imageTitles;
  }
  const icons = rows.map(row => row.iconResource);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i], icon = icons[i];
    if (row.password || row.editable || row.scrollable || row.longClickable || row.checked !== undefined) continue;
    if (row.clickable || (row.actions & 16)) {
      if (icon) row.iconResource = icon;
      continue;
    }
    if (icon === undefined || row.parent < 0) continue;
    // A control with multiple images has no single icon to use as its name.
    icons[row.parent] = icons[row.parent] === undefined ? icon : null;
  }
}

// Index images by the same host and virtual node IDs used in AccessibilityNodeInfo.
function projectedIconResources(root) {
  const ViewGroup = Java.use("android.view.ViewGroup");
  const ImageView = Java.use("android.widget.ImageView");
  const Listener = Java.use("android.view.accessibility.AccessibilityManager$AccessibilityStateChangeListener");
  const Iterable = Java.use("java.lang.Iterable"), List = Java.use("java.util.List");
  const Entry = Java.use("java.util.Map$Entry"), Uri = Java.use("android.net.Uri");
  const ReflectArray = Java.use("java.lang.reflect.Array"), ObjectType = Java.use("java.lang.Object");
  const fieldsByClass = new Map(), resourceNames = new Map();
  const images = new Map();
  const Bitmap = Java.use("android.graphics.Bitmap"), System = Java.use("java.lang.System");
  const pm = root.getContext().getPackageManager();
  function drawableName(resources, id) {
    const type = String(resources.getResourceTypeName(id));
    return type === "drawable" || type === "mipmap" ? String(resources.getResourceName(id)) : undefined;
  }
  function resolveUri(uri) {
    const source = String(uri);
    if (resourceNames.has(source)) return resourceNames.get(source);
    const segments = uri.getPathSegments(), pkg = value(uri.getAuthority());
    if (String(uri.getScheme()) !== "android.resource" || !pkg || segments.size() !== 1) return;
    const number = String(segments.get(0));
    if (!/^[1-9][0-9]{0,9}$/.test(number) || +number > 0x7fffffff) return;
    let name;
    try {
      const resources = pm.getResourcesForApplication.overload("java.lang.String").call(pm, pkg);
      name = drawableName(resources, Number(number));
    } catch (_) { /* This package may have been replaced while the window was visible. */ }
    resourceNames.set(source, name);
    return name;
  }
  const typeOf = (obj) => Java.cast(obj, ObjectType).getClass();
  function fields(type) {
    const name = String(type.getName());
    if (!fieldsByClass.has(name)) {
      const result = [];
      for (let c = type; c && !/^(?:android|java)\./.test(String(c.getName())); c = c.getSuperclass()) {
        for (const f of c.getDeclaredFields()) {
          if (f.getModifiers() & 8) continue;
          f.setAccessible(true);
          result.push({ f, type: f.getType(), name: String(f.getType().getName()) });
        }
      }
      fieldsByClass.set(name, result);
    }
    return fieldsByClass.get(name);
  }
  function sourceImage(object, key) {
    let image = images.get(key);
    if (!image) images.set(key, image = { object, titles: new Set() });
    if (object && !image.object.equals(object)) image.ambiguous = true;
    return image;
  }
  function modelImage(model, depth = 0) {
    const type = typeOf(model), members = fields(type);
    const sources = members.filter(x => x.name === "android.net.Uri" || x.name === "android.graphics.Bitmap");
    if (sources.length === 1) {
      const source = sources[0], object = source.f.get(model);
      if (!object) return;
      if (source.name === "android.graphics.Bitmap") return sourceImage(object, System.identityHashCode(object));
      const uri = Java.cast(object, Uri);
      if (String(uri.getScheme()) === "content") return sourceImage(null, String(uri));
      return resolveUri(uri);
    }
    if (depth >= 2 || sources.length) return;
    // A template can wrap a single image model, for example a row's leading icon.
    const markers = [...type.getInterfaces()].filter(i => !/^(?:java|android|kotlin)\./.test(String(i.getName())) &&
      !i.getDeclaredMethods().length && !i.getDeclaredFields().length);
    if (markers.length !== 1) return;
    const nested = members.filter(x => markers[0].isAssignableFrom(x.type)).map(x => x.f.get(model)).filter(Boolean);
    if (nested.length === 1) return modelImage(nested[0], depth + 1);
  }
  function readTemplateTitles() {
    if (!images.size) return;
    for (const [type, getter] of [["GridItem", "getImage"], ["Row", "getImage"], ["Tab", "getIcon"]]) {
      try {
        Java.choose("androidx.car.app.model." + type, {
          onMatch(item) {
            try {
              const icon = item[getter]()?.getIcon();
              if (!icon) return;
              const payload = fields(typeOf(icon)).filter(x => x.name === "java.lang.Object");
              if (payload.length !== 1) return;
              const object = payload[0].f.get(icon);
              if (!object) return;
              let image;
              if (Bitmap.class.isInstance(object)) {
                image = images.get(System.identityHashCode(object));
                if (!image?.object?.equals(object)) return;
              } else if (Uri.class.isInstance(object) || Java.use("java.lang.String").class.isInstance(object)) {
                image = images.get(String(object.toString()));
              }
              if (!image || image.ambiguous) return;
              const title = value(item.getTitle()).trim();
              if (title) image.titles.add(title);
            } catch (_) { /* An item can be partially constructed or lack an icon. */ }
          },
          onComplete() {},
        });
      } catch (_) { /* Not every renderer includes the Car App Library. */ }
    }
  }
  function imageResource(config) {
    const iter = Java.cast(config, Iterable).iterator();
    while (iter.hasNext()) {
      const pair = iter.next();
      if (!Entry.class.isInstance(pair)) return;
      const entry = Java.cast(pair, Entry);
      if (String(entry.getKey().toString()) !== "AccessibilityKey: UiModel") continue;
      const models = entry.getValue();
      if (!models || !List.class.isInstance(models)) return;
      const list = Java.cast(models, List);
      if (list.size() !== 1) return;
      const model = list.get(0);
      if (!model) return;
      return modelImage(model);
    }
  }
  function readIndex(host, provider, listenerField) {
    const delegate = listenerField.f.get(host);
    if (!delegate) return;
    const matches = [];
    for (const field of fields(typeOf(delegate))) {
      if (field.f.getModifiers() & 16 || field.type.isPrimitive()) continue;
      const members = fields(field.type);
      const keys = members.filter(x => x.name === "[I");
      const values = members.filter(x => x.name === "[Ljava.lang.Object;");
      if (keys.length === 1 && values.length === 1 && members.some(x => x.name === "[J"))
        matches.push({ field, keys: keys[0].f, values: values[0].f });
    }
    if (matches.length !== 1) return;
    // Asking the provider for its root refreshes the visible semantics index before field access.
    if (!provider.createAccessibilityNodeInfo(-1)) return;
    const { field, keys, values } = matches[0];
    const index = field.f.get(delegate);
    if (!index) return;
    const ids = keys.get(index), entries = values.get(index);
    const count = ReflectArray.getLength(ids);
    if (count > 4096 || count !== ReflectArray.getLength(entries)) return;
    const icons = new Map();
    for (let i = 0; i < count; i++) {
      const entry = ReflectArray.get(entries, i);
      if (!entry) continue;
      const id = ReflectArray.getInt(ids, i);
      if (id < 0) continue;
      for (const member of fields(typeOf(entry))) {
        if (member.type.isPrimitive()) continue;
        const node = member.f.get(entry);
        if (!node) continue;
        const members = fields(typeOf(node));
        const configs = members.filter(x => Iterable.class.isAssignableFrom(x.type));
        const nodeIds = members.filter(x => x.name === "int");
        if (configs.length !== 1 || nodeIds.length !== 1 || nodeIds[0].f.getInt(node) !== id) continue;
        const config = configs[0].f.get(node);
        const resource = config && imageResource(config);
        if (resource) icons.set(id, resource);
      }
    }
    return icons;
  }
  const hosts = new Map(), pending = [root];
  while (pending.length) {
    const view = pending.pop();
    if (!view.isShown()) continue;
    // ImageView keeps the active resource ID when Android supplied the drawable by resource.
    if (ImageView.class.isInstance(view)) {
      try {
        const image = Java.cast(view, ImageView);
        const id = image.mResource.value;
        const name = id && image.getDrawable() && drawableName(image.getResources(), id);
        if (name) hosts.set(view.getAccessibilityViewId(), new Map([[-1, name]]));
      } catch (_) { /* Some images have only a bitmap or a custom drawable. */ }
    }
    const provider = view.getAccessibilityNodeProvider();
    if (provider) {
      try {
        const listeners = fields(typeOf(view)).filter(x => Listener.class.isAssignableFrom(x.type));
        if (listeners.length === 1) {
          const icons = readIndex(view, provider, listeners[0]);
          if (icons?.size) hosts.set(view.getAccessibilityViewId(), icons);
        }
      } catch (_) { /* Renderer metadata is optional. */ }
    }
    if (ViewGroup.class.isInstance(view)) {
      const group = Java.cast(view, ViewGroup);
      for (let i = 0; i < group.getChildCount(); i++) pending.push(group.getChildAt(i));
    }
  }
  readTemplateTitles();
  return hosts;
}
