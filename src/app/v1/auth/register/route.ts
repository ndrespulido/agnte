import { handleRegister } from '@/modules/identity';

// Auth endpoints touch the database and per-request headers, so nothing here
// may be prerendered or cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handleRegister;
