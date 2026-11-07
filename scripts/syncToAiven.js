#!/usr/bin/env node

'use strict';

console.error(
  '❌ scripts/syncToAiven.js está obsoleto: el proyecto ahora usa PostgreSQL en Supabase. ' +
  'Usa scripts/migrate.js o el SQL de Supabase para gestionar el esquema.'
);
process.exitCode = 1;
