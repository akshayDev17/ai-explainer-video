import { lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './Layout';
import { Dashboard } from './pages/Dashboard';
import { settingsRoutes } from './settings/routes';

const Reports = lazy(() => import('./pages/Reports'));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'reports', element: <Reports /> },
      { path: 'audit', lazy: () => import('./pages/Audit') },
      { path: 'team/:teamId', Component: Dashboard },
    ],
  },
]);

export function Root() {
  return <RouterProvider router={router} />;
}

export { settingsRoutes };
