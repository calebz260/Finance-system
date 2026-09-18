import { Route, Routes } from 'react-router';

import { AppLayout } from './components/layout/AppLayout';
import { NotFoundPage } from './pages/NotFoundPage';
import { SystemStatusPage } from './pages/SystemStatusPage';

/**
 * Route table.
 *
 * Grows one module at a time; each new screen is added here only once its backend
 * workflow exists. Role-scoped dashboards and guarded routes arrive with authentication
 * in Phase 2.
 */
export function App(): React.JSX.Element {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<SystemStatusPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppLayout>
  );
}
