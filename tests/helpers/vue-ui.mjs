import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

export async function vueUi(t, { modules = {} } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'location', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  const directory = await mkdtemp(join(tmpdir(), 'member-v2-ui-'));
  const require = createRequire(import.meta.url);
  const { parse, compileScript } = await import('@vue/compiler-sfc');
  const vueUrl = pathToFileURL(require.resolve('vue')).href;
  const { createApp, nextTick } = await import(vueUrl);
  const compiled = new Map();
  let app;
  async function compile(source) {
    if (compiled.has(source.href)) return compiled.get(source.href);
    const output = pathToFileURL(join(directory, compiled.size + '.mjs'));
    compiled.set(source.href, output.href);
    const { descriptor, errors } = parse(await readFile(source, 'utf8'), { filename: source.pathname });
    assert.deepEqual(errors, []);
    let script = compileScript(descriptor, { id: output.href, inlineTemplate: true }).content;
    for (const [match, quote, specifier] of script.matchAll(/from (['"])([^'"]+)\1/g)) {
      const target = modules[specifier] ?? (specifier.endsWith('.vue') ? await compile(new URL(specifier, source))
        : specifier.startsWith('.') ? new URL(specifier, source).href : pathToFileURL(require.resolve(specifier)).href);
      script = script.replace(match, 'from ' + quote + target + quote);
    }
    await writeFile(output, script);
    return output.href;
  }
  const unmount = () => { app?.unmount(); app = null; };
  t.after(async () => {
    unmount(); dom.window.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    dom, directory, nextTick, unmount,
    async component(source) { return (await import(await compile(source))).default; },
    async mount(component, props) {
      unmount(); document.body.innerHTML = '<div id="app"></div>';
      app = createApp(component, props); app.mount('#app'); await nextTick();
    },
    button(label, root = document) {
      const button = [...root.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent.trim() === label);
      assert.ok(button, 'Missing button: ' + label); return button;
    },
    async input(selector, value, event = 'input') {
      const field = document.querySelector(selector);
      assert.ok(field, 'Missing field: ' + selector); field.value = value;
      field.dispatchEvent(new dom.window.Event(event, { bubbles: true })); await nextTick();
    }
  };
}

export function browserLocks() {
  const pending = new Map();
  return { request(name, action) {
    const result = (pending.get(name) ?? Promise.resolve()).then(action, action);
    const tail = result.catch(() => {}); pending.set(name, tail);
    return result.finally(() => { if (pending.get(name) === tail) pending.delete(name); });
  } };
}
