import { searchBooks, searchReviews } from '../api/catalog';

export default function SearchPage() {
  const run = async (shelf: string, q: string) => { await searchBooks(shelf, q); await searchReviews(shelf, q); };
  return <button onClick={() => run('s', 'q')}>Search</button>;
}
