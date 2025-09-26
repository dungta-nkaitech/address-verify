/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const DEFAULT_UA = 'address-verifier-web/1.0 (contact@example.com)';
const SLEEP_MS_NOMI = 1200;

// ===== Input / Output types =====
export type InRow = {
    SHIPPINGADDRESS: string;
    SHIPPINGCITY?: string;
    SHIPPINGZIPCODE?: string;
    SHIPPINGPROVINCE?: string;   // state / province
    SHIPPINGCOUNTRY?: string;    // ISO-2 ưu tiên (US/GB/AU/...)
};

type OutStatus = 'valid' | 'ambiguous' | 'not_found' | 'error';
type Provider = 'nominatim' | 'opencage';

type OutRow = {
    input_address: string;         // chuỗi ghép từ các trường
    cleaned_address: string;       // = input_address (không xử lý phức tạp)
    normalized_address: string;    // = input_address (không xử lý phức tạp)
    country: string;               // từ SHIPPINGCOUNTRY
    status: OutStatus;
    score: number;
    lat?: number;
    lon?: number;
    provider: Provider;
    match_level?: string;
    postal_code?: string;
    notes?: string;
};

// ===== Provider response types (strict) =====
type NominatimAddress = { postcode?: string };
type NominatimItem = { lat?: string; lon?: string; type?: string; address?: NominatimAddress };
type NominatimSearchResponse = NominatimItem[];

type OCGeometry = { lat: number; lng: number };
type OCComponents = {
    postcode?: string; postal_code?: string;
    road?: string; street?: string; pedestrian?: string;
    suburb?: string; village?: string; town?: string; city?: string; county?: string;
    building?: string; residential?: string; house_number?: string;
};
type OCResult = { geometry?: OCGeometry; components?: OCComponents; confidence?: number };
type OCResponse = { results?: OCResult[] };

// ===== Utils =====
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const postalValidators: Record<string, (p: string) => boolean> = {
    US: (p) => /^\d{5}(-\d{4})?$/.test(p || ''),
    CA: (p) => /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(p || ''),
    AU: (p) => /^\d{4}$/.test(p || ''),
    GB: (p) => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(p || ''),
};

function matchLevelFromNominatim(item: NominatimItem): string {
    const t = String(item?.type || '').toLowerCase();
    if (['house', 'building', 'residential', 'address'].includes(t)) return 'house';
    if (['road', 'street', 'service', 'tertiary', 'primary', 'secondary'].includes(t)) return 'street';
    if (['suburb', 'neighbourhood', 'hamlet', 'quarter'].includes(t)) return 'locality';
    if (['city', 'town', 'village', 'municipality', 'county', 'district'].includes(t)) return 'locality';
    return 'unknown';
}

function computeScore(
    matchLevel: string,
    reverseOk: boolean,
    candidates: number,
    postal: string | undefined,
    country?: string,
    opts: { inputPostal?: string } = {}
) {
    let score = 0;
    if (matchLevel === 'house') score += 50;
    else if (matchLevel === 'street') score += 35;
    else if (matchLevel === 'locality') score += 20;

    if (reverseOk) score += 20;

    const pv = postalValidators[country || ''] || (() => false);
    if (postal && pv(postal)) score += 10;

    if (opts.inputPostal && pv(opts.inputPostal) && postal && postal.toUpperCase() === opts.inputPostal.toUpperCase()) {
        score += 15;
    }

    score += 10;
    if (candidates >= 4) score -= 15;

    return Math.max(0, Math.min(100, score));
}

// ===== Providers =====
async function nominatimSearchFree(
    q: string,
    opts: { country?: string; debug?: boolean } = {}
): Promise<
    | { rawArray: NominatimSearchResponse; best: NominatimItem; matchLevel: string; reverseOk: boolean; postal?: string }
    | { status: 'not_found' }
    | { error: string }
> {
    const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '5', q });
    if (opts.country) params.set('countrycodes', String(opts.country).toLowerCase());
    const url = `${NOMINATIM_BASE}/search?${params.toString()}`;
    if (opts.debug) console.log('[Nominatim free-form]', url);

    try {
        const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const arr = (await res.json()) as NominatimSearchResponse;
        if (!Array.isArray(arr) || arr.length === 0) return { status: 'not_found' };
        const best = arr[0];
        const matchLevel = matchLevelFromNominatim(best);
        const reverseOk = !!(best.lat && best.lon);
        const postalFound = best.address?.postcode;
        return { rawArray: arr, best, matchLevel, reverseOk, postal: postalFound };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `nominatim_error:${msg}` };
    }
}

async function nominatimSearchStructured(
    args: { street: string; city: string; state: string; postalcode?: string; country: string },
    opts: { debug?: boolean } = {}
): Promise<
    | { rawArray: NominatimSearchResponse; best: NominatimItem; matchLevel: string; reverseOk: boolean; postal?: string }
    | { status: 'not_found' }
    | { error: string }
> {
    const params = new URLSearchParams({
        format: 'jsonv2',
        addressdetails: '1',
        limit: '5',
        street: args.street,
        city: args.city,
        state: args.state,
        postalcode: args.postalcode || '',
        country: args.country,
    });
    const url = `${NOMINATIM_BASE}/search?${params.toString()}`;
    if (opts.debug) console.log('[Nominatim structured]', url);

    try {
        const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const arr = (await res.json()) as NominatimSearchResponse;
        if (!Array.isArray(arr) || arr.length === 0) return { status: 'not_found' };
        const best = arr[0];
        const matchLevel = matchLevelFromNominatim(best);
        const reverseOk = !!(best.lat && best.lon);
        const postalFound = best.address?.postcode;
        return { rawArray: arr, best, matchLevel, reverseOk, postal: postalFound };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `nominatim_error:${msg}` };
    }
}

async function opencageGeocode(
    q: string,
    key: string,
    country?: string,
    opts: { debug?: boolean } = {}
): Promise<
    | {
          status: OutStatus;
          score: number;
          lat?: number;
          lon?: number;
          matchLevel: string;
          postal?: string;
          candidates: number;
      }
    | { status: 'not_found' }
> {
    if (!key) throw new Error('Missing OpenCage API key');
    const base = 'https://api.opencagedata.com/geocode/v1/json';
    const params = new URLSearchParams({ q, key, limit: '3', no_annotations: '1' });
    if (country) params.set('countrycode', String(country).toLowerCase());
    const url = `${base}?${params.toString()}`;
    if (opts.debug) console.log('[OpenCage]', url.replace(key, '****'));

    const res = await fetch(url);
    if (!res.ok) throw new Error('OpenCage HTTP ' + res.status);
    const j = (await res.json()) as OCResponse;
    const results = j.results || [];
    if (!results.length) return { status: 'not_found' };

    const r0 = results[0];
    const comps = r0.components || {};
    const hasHouse = (!!comps.house_number && (!!comps.road || !!comps.street)) || !!comps.building || !!comps.residential;
    const hasStreet = !!comps.road || !!comps.street || !!comps.pedestrian;
    const hasLocal = !!comps.suburb || !!comps.village || !!comps.town || !!comps.city || !!comps.county;
    const matchLevel = hasHouse ? 'house' : hasStreet ? 'street' : hasLocal ? 'locality' : 'unknown';

    const lat = r0.geometry?.lat;
    const lon = r0.geometry?.lng;
    const postal = comps.postcode || comps.postal_code;
    const candidates = results.length;

    let score = computeScore(matchLevel, !!(lat && lon), candidates, postal, country);
    const ocConf = typeof r0.confidence === 'number' ? r0.confidence : undefined;
    if (ocConf !== undefined) score += Math.min(10, Math.max(0, ocConf));
    score = Math.max(0, Math.min(100, score));

    const status: OutStatus = score >= 80 ? 'valid' : score >= 60 ? 'ambiguous' : 'not_found';
    return { status, score, lat, lon, matchLevel, postal, candidates };
}

function pickBestByScore(a: OutRow, b: OutRow) {
    return (a?.score || 0) >= (b?.score || 0) ? a : b;
}

// ===== Handler =====
export async function POST(req: Request) {
    const body = (await req.json().catch(() => null)) as { rows: InRow[]; debug?: boolean } | null;
    if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
        return NextResponse.json({ message: 'Body must be { rows: InRow[], debug? }' }, { status: 400 });
    }

    const { rows, debug } = body;
    const ocKey = process.env.OPENCAGE_API_KEY || '';
    let lastNomi = Date.now() - SLEEP_MS_NOMI;
    const out: OutRow[] = [];

    for (const r of rows) {
        const street  = (r.SHIPPINGADDRESS || '').trim();
        const city    = (r.SHIPPINGCITY || '').trim();
        const zip     = (r.SHIPPINGZIPCODE || '').trim();
        const state   = (r.SHIPPINGPROVINCE || '').trim();
        const country = (r.SHIPPINGCOUNTRY || '').trim().toUpperCase();

        const full = [street, city, state, zip, country].filter(Boolean).join(', ');
        const inputPostal = zip;

        // 1) Ưu tiên structured (US có đủ street+city+state)
        let usedStructured = false;
        let nomi:
            | { rawArray: NominatimSearchResponse; best: NominatimItem; matchLevel: string; reverseOk: boolean; postal?: string }
            | { status: 'not_found' }
            | { error: string };

        if (country === 'US' && street && city && state) {
            const waitA = Math.max(0, SLEEP_MS_NOMI - (Date.now() - lastNomi)); if (waitA) await sleep(waitA);
            nomi = await nominatimSearchStructured(
                { street, city, state, postalcode: zip || '', country: 'US' },
                { debug }
            );
            lastNomi = Date.now();
            usedStructured = 'rawArray' in nomi;
        } else {
            nomi = { status: 'not_found' };
        }

        // 2) Nếu structured không dùng được / không có kết quả → free-form
        if (!('rawArray' in nomi)) {
            const waitB = Math.max(0, SLEEP_MS_NOMI - (Date.now() - lastNomi)); if (waitB) await sleep(waitB);
            nomi = await nominatimSearchFree(full, { country, debug });
            lastNomi = Date.now();
        }

        // 3) Build result từ Nominatim
        let result: OutRow;
        if ('rawArray' in nomi) {
            const candidates = (nomi.rawArray || []).length;
            const lat = nomi.best.lat ? parseFloat(nomi.best.lat) : undefined;
            const lon = nomi.best.lon ? parseFloat(nomi.best.lon) : undefined;
            const score = computeScore(nomi.matchLevel, nomi.reverseOk, candidates, nomi.postal, country, { inputPostal });
            const status: OutStatus = score >= 80 ? 'valid' : score >= 60 ? 'ambiguous' : 'not_found';

            result = {
                input_address: full,
                cleaned_address: full,
                normalized_address: full,
                country: country || '',
                status,
                score,
                lat,
                lon,
                provider: 'nominatim',
                match_level: nomi.matchLevel,
                postal_code: nomi.postal || '',
                notes: `nominatim_candidates=${candidates}${usedStructured ? '; us_structured=1' : ''}`,
            };
        } else {
            const errNote = 'error' in nomi ? nomi.error : 'nominatim_not_found';
            result = {
                input_address: full,
                cleaned_address: full,
                normalized_address: full,
                country: country || '',
                status: 'error',
                score: 0,
                provider: 'nominatim',
                notes: errNote,
            };
        }

        // 4) OpenCage fallback nếu điểm thấp
        if (ocKey && result.score < 80) {
            try {
                const oc = await opencageGeocode(full, ocKey, country, { debug });
                if (oc.status !== 'not_found') {
                    const ocScore = computeScore(oc.matchLevel, true, oc.candidates || 1, oc.postal, country, { inputPostal });
                    const ocRes: OutRow = {
                        input_address: full,
                        cleaned_address: full,
                        normalized_address: full,
                        country: country || '',
                        status: ocScore >= 80 ? 'valid' : ocScore >= 60 ? 'ambiguous' : 'not_found',
                        score: ocScore,
                        lat: oc.lat,
                        lon: oc.lon,
                        provider: 'opencage',
                        match_level: oc.matchLevel,
                        postal_code: oc.postal || '',
                        notes: `opencage_candidates=${oc.candidates || 1}`,
                    };
                    result = pickBestByScore(result, ocRes);
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                result.notes = (result.notes ? result.notes + '; ' : '') + `opencage_error=${msg}`;
            }
        }

        out.push(result);
    }

    return NextResponse.json({ data: out });
}
