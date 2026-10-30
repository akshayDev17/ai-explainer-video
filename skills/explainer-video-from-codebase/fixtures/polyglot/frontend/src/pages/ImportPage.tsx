import { importBooks } from '../api/catalog';

export function ImportPage() {
  const go = async (shelf: string) => { await importBooks(shelf); };
  return <button onClick={() => go('s')}>Import</button>;
}
