import { Routes, Route } from 'react-router-dom';
import { SettingsHome, Profile } from './pages';

export function settingsRoutes() {
  return (
    <Routes>
      <Route path="/settings" element={<SettingsHome />}>
        <Route path="profile" element={<Profile />} />
        <Route index element={<SettingsHome />} />
      </Route>
    </Routes>
  );
}
