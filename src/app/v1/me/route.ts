import { handleMe, handleUpdateMe } from '@/modules/identity';
import { handleEraseMe } from '@/modules/privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handleMe;

export const PATCH = handleUpdateMe;

export const DELETE = handleEraseMe;
