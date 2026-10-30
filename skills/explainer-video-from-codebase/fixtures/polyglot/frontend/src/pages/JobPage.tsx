import { jobStatus } from '../api/catalog';

export function JobPage() {
  const load = async (id: string) => jobStatus(id);
  return <div onClick={() => load('1')} />;
}
