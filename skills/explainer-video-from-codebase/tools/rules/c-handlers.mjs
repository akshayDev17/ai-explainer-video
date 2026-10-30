/* Rule pack: C and C++ string-to-handler tables. A table is
   - a C array of rows, each a string and a function (`{ "add", cmd_add }`, `{ .name = "list", .run = cmd_list }`);
   - a C++ map initialised with such pairs (`std::map<std::string, Handler> t = {{"add", cmd_add}, …}`), a lambda
     value included (named `t["add"]`), or filled by assignments (`t["add"] = cmd_add;`, `this->t_["x"] = …`).
   Each row is a `command` entry at its function, keyed by its string. A function that names the table and calls
   through it — the row's function field of a C struct (`c->run(…)`, `commands[i].run(…)`), or a C++ map's value
   (`t[name](…)`, `t.at(name)(…)`, `it->second(…)`) — is the dispatcher: a `dispatch` edge to every row's function,
   one site, so a walk from the dispatcher folds them as alternatives and each command is its own flow. */
import { addCEdge } from '../lang/c.mjs';

export function handlerTables(cm, R) {
  const entries = [], claimed = new Set(), tables = [];
  // assignments to one map (`t["a"] = f; t["b"] = g;`) are one table
  const byName = new Map();
  for (const t of cm.tables) {
    const name = t.name.replace(/^this->/, '');
    const key = t.assigned ? `${t.module}#${name}` : t.var;
    if (!byName.has(key)) { byName.set(key, { ...t, name, rows: [] }); tables.push(byName.get(key)); }
    byName.get(key).rows.push(...t.rows);
  }
  for (const t of tables) {
    const sc = { module: t.module, ns: t.ns || [] };
    const k = !t.map && t.elemType ? R.classNamed(t.elemType, sc) : null;
    const fieldAt = i => k ? cm.classes.get(k).fieldOrder[i] : null;
    t.handlers = [];
    for (const r of t.rows) {
      const key = r.cells.find(x => x.str != null)?.str;
      const fnCell = r.cells.find(x => x.fnId || (x.ref && R.funcNamed(x.ref, sc)));
      if (key == null || !fnCell) continue;
      const id = fnCell.fnId || R.funcNamed(fnCell.ref, sc);
      t.field ||= fnCell.field || fieldAt(fnCell.i);
      t.handlers.push({ key, id, line: r.line });
      entries.push({ kind: 'command', key, id, file: t.file, line: r.line, rule: 'c.handler-table', table: t.name });
    }
  }
  // the dispatcher: a function that names the table and calls through a row (C) or a map value (C++)
  const links = [];
  cm.rawCalls.forEach((c, i) => {
    if (c.isNew || c.top) return;
    const refs = cm.refs.get(c.from);
    for (const t of tables) {
      if (!t.handlers.length || !refs?.has(t.name)) continue;
      const through = t.map ? (c.fnType === 'subscript_expression' || c.fnType === 'call_expression' || c.attr === 'second') : (c.attr && c.attr === t.field);
      if (!through) continue;
      claimed.add(i);
      const site = `${c.from}@${c.line}:${t.name}`;
      for (const h of t.handlers) addCEdge(cm, c.from, h.id, 'dispatch', c.line, { site, rule: 'c.handler-table', key: h.key,
        evidence: `${c.file}:${c.line} calls the ${t.name} row for "${h.key}" (${t.file}:${h.line})` });
      links.push({ from: c.from, table: t.name, file: c.file, line: c.line, handlers: t.handlers.length });
    }
  });
  return { entries, claimed, tables: tables.filter(t => t.handlers.length).map(t => ({ name: t.name, file: t.file, line: t.line, rows: t.handlers.length, field: t.field || null })), dispatchers: links };
}
