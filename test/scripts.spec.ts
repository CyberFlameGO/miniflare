import path from "path";
import { TextEncoder } from "util";
import test from "ava";
import micromatch from "micromatch";
import {
  ModuleRule,
  ProcessedModuleRule,
  stringScriptPath,
} from "../src/options";
import { ScriptBlueprint, ScriptError, buildLinker } from "../src/scripts";

const micromatchOptions: micromatch.Options = { contains: true };
const moduleRules: ModuleRule[] = [
  { type: "ESModule", include: ["**/*.mjs"] },
  { type: "CommonJS", include: ["**/*.js", "**/*.cjs"] },
  { type: "Text", include: ["**/*.txt"] },
  { type: "Data", include: ["**/*.bin"] },
  { type: "CompiledWasm", include: ["**/*.wasm"] },
  // @ts-expect-error intentionally testing unsupported module types
  { type: "PNG", include: ["**/*.png"] },
];
const processedModuleRules = moduleRules.map<ProcessedModuleRule>((rule) => ({
  type: rule.type,
  include: rule.include.map((glob) =>
    micromatch.makeRe(glob, micromatchOptions)
  ),
}));

test("buildScript: runs code in sandbox", async (t) => {
  t.plan(1);
  const blueprint = new ScriptBlueprint(`callback("test")`, "test.js");
  const script = await blueprint.buildScript({
    callback: (result: string) => t.is(result, "test"),
  });
  await script.run();
});
test("buildScript: disallows code generation", async (t) => {
  const blueprint = new ScriptBlueprint(`eval('callback()')`, "test.js");
  const script = await blueprint.buildScript({ callback: () => t.fail() });
  await t.throwsAsync(script.run(), {
    message: "Code generation from strings disallowed for this context",
  });
});
test("buildScript: includes file name in stack traces", async (t) => {
  const blueprint = new ScriptBlueprint(`throw new Error("test")`, "test.js");
  const script = await blueprint.buildScript({});
  try {
    await script.run();
    t.fail();
  } catch (e) {
    t.true(e.stack.includes("at test.js:1"));
  }
});

test("buildModule: runs code in sandbox", async (t) => {
  t.plan(1);
  const blueprint = new ScriptBlueprint(`callback("test")`, "test.mjs");
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule(
    { callback: (result: string) => t.is(result, "test") },
    linker
  );
  await script.run();
});
test("buildModule: disallows code generation", async (t) => {
  const blueprint = new ScriptBlueprint(`eval('callback()')`, "test.mjs");
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule(
    { callback: () => t.fail() },
    linker
  );
  await t.throwsAsync(script.run(), {
    message: "Code generation from strings disallowed for this context",
  });
});
test("buildModule: includes file name in stack traces", async (t) => {
  const blueprint = new ScriptBlueprint(`throw new Error("test")`, "test.mjs");
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  try {
    await script.run();
    t.fail();
  } catch (e) {
    t.true(e.stack.includes("at test.mjs:1"));
  }
});
test("buildModule: exposes exports", async (t) => {
  const blueprint = new ScriptBlueprint(
    `export const a = "a"; export default "b";`,
    "test.mjs"
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.is(script.exports.a, "a");
  t.is(script.exports.default, "b");
});

// Path of fake linker test script, linked modules are resolved relative to this
const linkerScriptPath = path.resolve(
  __dirname,
  "fixtures",
  "modules",
  "test.mjs"
);

test("buildLinker: links ESModule modules", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./esmodule.mjs"; export default value;`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.is(script.exports.default, "ESModule test");
});
test("buildLinker: links CommonJS modules", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./commonjs.cjs"; export default value;`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.is(script.exports.default, "CommonJS test");
});
test("buildLinker: links Text modules", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./text.txt"; export default value;`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.is(script.exports.default, "Text test\n");
});
test("buildLinker: links Data modules", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./data.bin"; export default value;`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.deepEqual(
    script.exports.default,
    new TextEncoder().encode("Data test\n").buffer
  );
});
test("buildLinker: links CompiledWasm modules", async (t) => {
  const blueprint = new ScriptBlueprint(
    // add.wasm is a WebAssembly module with a single export "add" that adds
    // its 2 integer parameters together and returns the result, it is from:
    // https://webassembly.github.io/wabt/demo/wat2wasm/
    `
    import addModule from "./add.wasm";
    const instance = new WebAssembly.Instance(addModule);
    export default instance.exports.add(1, 2);
    `,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  const script = await blueprint.buildModule({}, linker);
  await script.run();
  t.is(script.exports.default, 3);
});
test("buildLinker: builds set of linked module paths", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./recursive.mjs"`,
    linkerScriptPath
  );
  const { linker, referencedPaths } = buildLinker(processedModuleRules);
  await blueprint.buildModule({}, linker);
  const dir = path.dirname(linkerScriptPath);
  t.deepEqual(
    referencedPaths,
    new Set([path.join(dir, "recursive.mjs"), path.join(dir, "esmodule.mjs")])
  );
});
test("buildLinker: throws error if trying to import from string script", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import value from "./esmodule.mjs"`,
    stringScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  await t.throwsAsync(blueprint.buildModule({}, linker), {
    instanceOf: ScriptError,
    message: /imports unsupported with string script$/,
  });
});
test("buildLinker: throws error if no matching module rule", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import image from "./image.jpg"`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  await t.throwsAsync(blueprint.buildModule({}, linker), {
    instanceOf: ScriptError,
    message: /no matching module rules$/,
  });
});
test("buildLinker: throws error for unsupported module type", async (t) => {
  const blueprint = new ScriptBlueprint(
    `import image from "./image.png"`,
    linkerScriptPath
  );
  const { linker } = buildLinker(processedModuleRules);
  await t.throwsAsync(blueprint.buildModule({}, linker), {
    instanceOf: ScriptError,
    message: /PNG modules are unsupported$/,
  });
});
