import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../../backend/frida/projected-icons.js", import.meta.url), "utf8");
const attach = runInNewContext(source + "\nattachControlIcons");

test("only one image in the control's own subtree supplies its drawable", () => {
  const button = parent => ({ parent, clickable: true, actions: 16 });
  const icon = (parent, name) => ({ parent, iconResource: "app:drawable/" + name });
  const rows = [button(-1), { parent: 0 }, icon(1, "back"), button(0), icon(3, "next"),
    button(-1), icon(5, "a"), icon(5, "b")];
  attach(rows);
  assert.equal(rows[0].iconResource, "app:drawable/back");
  assert.equal(rows[3].iconResource, "app:drawable/next");
  assert.equal(rows[5].iconResource, undefined);
});

test("artwork requires exactly one source title present inside its own control", () => {
  const titles = new Set(["One", "Two"]);
  const rows = [{ parent: -1, clickable: true }, { parent: 0, imageTitles: titles }, { parent: 0, text: "One" },
    { parent: 0, clickable: true }, { parent: 3, imageTitles: titles }, { parent: 3, text: "Unrelated" },
    { parent: -1, clickable: true }, { parent: 6, imageTitles: titles },
    { parent: 6, text: "One" }, { parent: 6, text: "Two" }];
  attach(rows);
  assert.equal(rows[1].imageItemTitle, "One");
  assert.equal(rows[4].imageItemTitle, undefined);
  assert.equal(rows[7].imageItemTitle, undefined);
  assert.equal(rows[1].imageTitles, undefined);
});
