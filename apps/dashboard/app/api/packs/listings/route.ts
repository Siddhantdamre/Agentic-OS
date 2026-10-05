import { GET } from '../../listings/route';

/** Listings UI also probes /api/packs/listings. */
export { /* @next-codemod-error `GET` export is re-exported. Check if this component uses `params` or `searchParams`*/
GET };
export const dynamic = 'force-dynamic';
