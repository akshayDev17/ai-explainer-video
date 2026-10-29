/* Rule pack: click / typer. Only a command decorator makes a CLI entry; `@click.option` and friends decorate
   the same function and must not make one entry each. */
export function commandEntry(py, d, entries) {
  if (!/(^|\.)command$|^app\.callback$/.test(d.expr) || entries.some(e => e.kind === 'cli' && e.id === d.id)) return null;
  return { kind: 'cli', id: d.id, line: d.line, file: py.symbols.get(d.id).file, rule: 'click-typer.command' };
}
