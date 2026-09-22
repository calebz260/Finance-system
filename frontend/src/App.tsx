import { Route, Routes } from 'react-router';

import { PermissionKey } from '@sfs/shared';

import { RequireAuth } from './components/auth/RequireAuth';
import { AppLayout } from './components/layout/AppLayout';
import { AcademicPage } from './pages/AcademicPage';
import { AccountPage } from './pages/AccountPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ChargeRunPage } from './pages/ChargeRunPage';
import { FeesPage } from './pages/FeesPage';
import { StudentFinancialsPage } from './pages/StudentFinancialsPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PaymentDetailPage } from './pages/PaymentDetailPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { PayPage } from './pages/PayPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SignInPage } from './pages/SignInPage';
import { StudentDetailPage } from './pages/StudentDetailPage';
import { StudentImportPage } from './pages/StudentImportPage';
import { StudentRegisterPage } from './pages/StudentRegisterPage';
import { StudentsPage } from './pages/StudentsPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Route table.
 *
 * Grows one module at a time; each new screen is added here only once its backend
 * workflow exists.
 *
 * The split that matters is between the public routes — the three a person reaches
 * precisely because they cannot sign in — and everything behind `RequireAuth`. The
 * guard decides what to render; the server decides what is allowed, and re-reads the
 * caller's permissions from the database on every request to do it.
 */
export function App(): React.JSX.Element {
  return (
    <AppLayout>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        <Route
          path="/"
          element={
            <RequireAuth>
              <SystemStatusPage />
            </RequireAuth>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        {/* Reachable by an account that must change its password, and by no other route. */}
        <Route
          path="/account/password"
          element={
            <RequireAuth>
              <ChangePasswordPage />
            </RequireAuth>
          }
        />
        <Route
          path="/students"
          element={
            <RequireAuth permissions={[PermissionKey.STUDENT_READ]}>
              <StudentsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/students/new"
          element={
            <RequireAuth permissions={[PermissionKey.STUDENT_CREATE]}>
              <StudentRegisterPage />
            </RequireAuth>
          }
        />
        {/* Before the :studentId route, or "import" is read as an id. */}
        <Route
          path="/students/import"
          element={
            <RequireAuth permissions={[PermissionKey.STUDENT_IMPORT]}>
              <StudentImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/students/:studentId"
          element={
            <RequireAuth permissions={[PermissionKey.STUDENT_READ]}>
              <StudentDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/academic"
          element={
            <RequireAuth permissions={[PermissionKey.ACADEMIC_READ]}>
              <AcademicPage />
            </RequireAuth>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAuth permissions={[PermissionKey.USER_READ]}>
              <UsersPage />
            </RequireAuth>
          }
        />

        {/* Fees. Configuration and billing are separate routes because they are
            separate permissions: setting a price is not the same act as charging it. */}
        <Route
          path="/fees"
          element={
            <RequireAuth permissions={[PermissionKey.FEE_STRUCTURE_READ]}>
              <FeesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/fees/charge-runs"
          element={
            <RequireAuth permissions={[PermissionKey.CHARGE_READ]}>
              <ChargeRunPage />
            </RequireAuth>
          }
        />
        <Route
          path="/students/:studentId/financials"
          element={
            <RequireAuth permissions={[PermissionKey.CHARGE_READ]}>
              <StudentFinancialsPage />
            </RequireAuth>
          }
        />

        {/* Payments. The list and the detail screen are reachable two ways — by staff
            with `payment.read`, and by a family with `own.financials_read` — because they
            are the same records seen from two sides. The guard lets either through; the
            server decides which payments each of them actually sees. */}
        <Route
          path="/payments"
          element={
            <RequireAuth
              anyPermission={[PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ]}
            >
              <PaymentsPage />
            </RequireAuth>
          }
        />
        {/* Before the :paymentId route, or "pay" is read as an id. */}
        <Route
          path="/payments/pay"
          element={
            <RequireAuth permissions={[PermissionKey.OWN_FINANCIALS_READ]}>
              <PayPage />
            </RequireAuth>
          }
        />
        <Route
          path="/payments/:paymentId"
          element={
            <RequireAuth
              anyPermission={[PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ]}
            >
              <PaymentDetailPage />
            </RequireAuth>
          }
        />

        {/* Reconciliation is the school's view of its own bank account. No self-service
            permission appears here, and none should: a family has no business in it. */}
        <Route
          path="/reconciliation"
          element={
            <RequireAuth permissions={[PermissionKey.RECONCILIATION_READ]}>
              <ReconciliationPage />
            </RequireAuth>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppLayout>
  );
}
