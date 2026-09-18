import { Link } from 'react-router';

import { Card, CardBody } from '../components/ui/Card';

export function NotFoundPage(): React.JSX.Element {
  return (
    <Card>
      <CardBody className="py-12 text-center">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Page not found</h1>
        <p className="mx-auto mt-2 max-w-prose text-sm text-slate-600 dark:text-slate-400">
          The page you asked for does not exist. If you followed a link from an email or a receipt,
          please check it with the bursar&rsquo;s office.
        </p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Back to system status
        </Link>
      </CardBody>
    </Card>
  );
}
