import { createBrowserRouter } from 'react-router-dom';
import { Route, Routes } from 'react-router-dom';
import SearchPage from './pages/SearchPage';
import { ImportPage } from './pages/ImportPage';
import { JobPage } from './pages/JobPage';
import { StockPage } from './pages/StockPage';

export const router = createBrowserRouter([
  { path: '/search', element: <SearchPage /> },
  { path: '/shelves/:shelf/import', element: <ImportPage /> },
  { path: '/stock/:isbn', element: <StockPage /> },
]);

export function LegacyRoutes() {
  return (
    <Routes>
      <Route path="/jobs/:id" element={<JobPage />} />
    </Routes>
  );
}
