-- Integration tests run against a separate database so a test reset can never
-- truncate development data. Created once, on first container initialisation.
SELECT 'CREATE DATABASE school_finance_test'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'school_finance_test') \gexec
