import { handleExportStatus, handleRequestExport } from '@/modules/privacy';

export const dynamic = 'force-dynamic';

export const GET = handleExportStatus;
export const POST = handleRequestExport;
