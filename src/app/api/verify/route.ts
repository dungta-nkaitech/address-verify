import { NextResponse } from 'next/server';

export const runtime = 'nodejs'; // dùng Node runtime (cần cho fetch server-side chuẩn)

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const DEFAULT_UA = 'address-verifier-web/1.0 (contact@example.com)';
const SLEEP_MS_NOMI = 1200;

type InRow = { address: string; country?: string };
type OutRow = {
    input_address: string; cleaned_address: string; normalized_address: string; country: string;
    status: 'valid'|'ambiguous'|'not_found'|'error'; score: number; lat?: number; lon?: number;
    provider: 'nominatim'|'opencage'; match_level?: string; postal_code?: string; notes?: string;
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
const postalValidators: Record<string,(p:string)=>boolean> = {
    US: p => /^\d{5}(-\d{4})?$/.test(p||''), CA: p => /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(p||''),
    AU: p => /^\d{4}$/.test(p||''), GB: p => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(p||''),
};

// --- helpers (rút gọn từ script gốc) ---
function stripPersonals(s:string){ if(!s)return''; let x=s.trim();
    x=x.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,''); x=x.replace(/(\+?\d[\d\s().-]{6,}\d)/g,'');
    const parts=x.split(/\r?\n/).filter(Boolean); if(parts.length>=2){const a=/\d/.test(parts[0]);const b=/\d/.test(parts[1]); if(!a&&b)parts.shift();}
    return parts.join(', ').replace(/\s{2,}/g,' ').trim();
}
function insertCommaAfterStreetSuffix(s:string){return s?.replace(/\b(Rd|Dr|St|Ave|Av|Blvd|Ln|Pkwy|Pl|Plz|Ct|Cir|Way|Trl|Ter|Hwy|Mnr|Cres|Close|Grv|Mews|Pde|Parade|Sq|Quay|Wharf)(?=[A-Z])/g,'$1, ').replace(/\s{2,}/g,' ')||s;}
function normalizeRegionTokens(s:string){return s?.replace(/\b(South\s+Carolina)\b/gi,'SC').replace(/\b(California)\b/gi,'CA').replace(/\b(nsw|vic|qld|sa|tas|wa|nt|act)\b/gi,m=>m.toUpperCase())||s;}
function softenUnitTokens(s:string){return s?.replace(/\b(Apt|Apartment|Suite|Ste|Unit|Fl|Floor|Lvl|Level|Bldg|Building|Room|Rm)\b\.?\s*([\w\-#]+)/gi,'$1 $2, ')||s;}
function tidyCountryComma(s:string){return s?.replace(/\s+(US|USA|United States|Canada|Australia|France|United Kingdom|UK)\s*$/i,', $1')||s;}
function euCommaFix(s:string){return s?.replace(/(\b\d{4,6}\b\s+[A-Z][A-Z0-9\- ]+)\s+(France|Deutschland|Germany|Italia|Italy|España|Spain|United Kingdom|UK)\b/gi,'$1, $2')||s;}
function autoCleanAddress(raw:string){ if(!raw)return''; let s=String(raw); s=stripPersonals(s); s=s.replace(/\s*\n+\s*/g,', '); s=s.replace(/\s{2,}/g,' ').trim();
    s=insertCommaAfterStreetSuffix(s); s=soffenUnitTokens(s); function soffenUnitTokens(x:string){return softenUnitTokens(x);}
    s=normalizeRegionTokens(s); s=tidyCountryComma(s); s=euCommaFix(s); s=s.replace(/[;,.\s]+$/g,''); return s.trim();
}
function detectCountry(address:string, explicit?:string, def?:string){
    if(explicit) return explicit.toUpperCase(); const s=address||'';
    if(/\bCanada\b/i.test(s)) return 'CA'; if(/\bCalifornia\b/i.test(s)) return 'US'; if(/\bFrance\b/i.test(s)) return 'FR';
    if(/\b(United\s*States|USA|US)\b/i.test(s)) return 'US'; if(/\b(Australia|AU|AUS)\b/i.test(s)) return 'AU';
    if(/\b(United\s*Kingdom|UK|GB)\b/i.test(s)) return 'GB'; if(/\b(Germany|Deutschland)\b/i.test(s)) return 'DE';
    if(/\b(Italy|Italia)\b/i.test(s)) return 'IT'; if(/\b(Spain|España)\b/i.test(s)) return 'ES';
    if(/\bCA\b/.test(s)){ if(/\bCA\s+\d{5}(-\d{4})?\b/.test(s)) return 'US'; if(/[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d/.test(s)) return 'CA'; }
    if(/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(s)) return 'US';
    if(postalValidators.CA(s.match(/[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d/)?.[0]||'')) return 'CA';
    if(postalValidators.GB(s.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i)?.[0]||'')) return 'GB';
    if(postalValidators.AU(s.match(/\b\d{4}\b/)?.[0]||'') && /\b(NSW|VIC|QLD|SA|TAS|WA|NT|ACT)\b/i.test(s)) return 'AU';
    return def ? def.toUpperCase() : '';
}
function normalizeAddress(raw:string, country?:string){ if(!raw)return''; let s=raw.trim().replace(/\s+/g,' ').replace(/[;,.\s]+$/g,'');
    if(country){ const has=/\b(US|USA|United States|Canada|CA|Australia|AU|AUS|France|Germany|Italia|Italy|España|Spain|United Kingdom|UK)\b/i.test(s);
        if(!has && !new RegExp(`\\b${country}\\b`,'i').test(s)) s=`${s}, ${country}`;}
    return s;
}
function matchLevelFromNominatim(item:any){ const t=String(item?.type||'').toLowerCase();
    if(['house','building','residential','address'].includes(t))return'house';
    if(['road','street','service','tertiary','primary','secondary'].includes(t))return'street';
    if(['suburb','neighbourhood','hamlet','quarter','city','town','village','municipality','county','district'].includes(t))return'locality';
    return 'unknown';
}
function computeScore(matchLevel:string, reverseOk:boolean, candidates:number, postal?:string, country?:string, opts:{inputPostal?:string}={}){
    let score=0; if(matchLevel==='house')score+=50; else if(matchLevel==='street')score+=35; else if(matchLevel==='locality')score+=20;
    if(reverseOk)score+=20; const pv=postalValidators[country||'']||(()=>false); if(postal && pv(postal))score+=10;
    if(opts.inputPostal && pv(opts.inputPostal) && postal && postal.toUpperCase()===opts.inputPostal.toUpperCase())score+=15;
    score+=10; if(candidates>=4)score-=15; return Math.max(0,Math.min(100,score));
}
function parseUS(address:string){ const m=address.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i); if(!m)return null;
    return { street:m[1].trim(), city:m[2].trim(), state:m[3].trim().toUpperCase(), zip:m[4].trim(), country:'US' };
}
async function nominatimSearchFree(q:string, {country,debug}:{country?:string;debug?:boolean}={}){
    const p=new URLSearchParams({format:'jsonv2',addressdetails:'1',limit:'5',q}); if(country)p.set('countrycodes',country.toLowerCase());
    const url=`${NOMINATIM_BASE}/search?${p.toString()}`; if(debug)console.log('[Nominatim free-form]',url);
    try{ const res=await fetch(url,{headers:{'User-Agent':DEFAULT_UA}}); if(!res.ok)throw new Error('HTTP '+res.status);
        const arr:any[]=await res.json(); if(!Array.isArray(arr)||!arr.length) return {status:'not_found'};
        const best=arr[0]; const matchLevel=matchLevelFromNominatim(best); const reverseOk=!!(best.lat&&best.lon); const postal=best.address?.postcode;
        return {rawArray:arr,best,matchLevel,reverseOk,postal};
    }catch(e:any){ return {error:'nominatim_error:'+e.message}; }
}
async function nominatimSearchStructured(a:{street:string;city:string;state:string;postalcode?:string;country:string},{debug}:{debug?:boolean}={}){
    const p=new URLSearchParams({format:'jsonv2',addressdetails:'1',limit:'5',street:a.street,city:a.city,state:a.state,postalcode:a.postalcode||'',country:a.country});
    const url=`${NOMINATIM_BASE}/search?${p.toString()}`; if(debug)console.log('[Nominatim structured]',url);
    try{ const res=await fetch(url,{headers:{'User-Agent':DEFAULT_UA}}); if(!res.ok)throw new Error('HTTP '+res.status);
        const arr:any[]=await res.json(); if(!Array.isArray(arr)||!arr.length) return {status:'not_found'};
        const best=arr[0]; const matchLevel=matchLevelFromNominatim(best); const reverseOk=!!(best.lat&&best.lon); const postal=best.address?.postcode;
        return {rawArray:arr,best,matchLevel,reverseOk,postal};
    }catch(e:any){ return {error:'nominatim_error:'+e.message}; }
}
async function opencageGeocode(q:string,key:string,country?:string,{debug}:{debug?:boolean}={}){
    if(!key) throw new Error('Missing OpenCage API key');
    const p=new URLSearchParams({q,key,limit:'3',no_annotations:'1'}); if(country)p.set('countrycode',country.toLowerCase());
    const url=`https://api.opencagedata.com/geocode/v1/json?${p.toString()}`; if(debug)console.log('[OpenCage]',url.replace(key,'****'));
    const res=await fetch(url); if(!res.ok) throw new Error('OpenCage HTTP '+res.status);
    const j:any=await res.json(); const rs=j.results||[]; if(!rs.length) return {status:'not_found'};
    const r0=rs[0]; const comps=r0.components||{}; const hasHouse=(comps.house_number&&(comps.road||comps.street))||comps.building||comps.residential;
    const hasStreet=comps.road||comps.street||comps.pedestrian; const hasLocal=comps.suburb||comps.village||comps.town||comps.city||comps.county;
    const matchLevel=hasHouse?'house':(hasStreet?'street':(hasLocal?'locality':'unknown')); const lat=r0.geometry?.lat; const lon=r0.geometry?.lng;
    const postal=comps.postcode||comps.postal_code; const candidates=rs.length;
    let score=computeScore(matchLevel,!!(lat&&lon),candidates,postal,country); const conf=typeof r0.confidence==='number'?r0.confidence:undefined;
    if(conf!==undefined) score+=Math.min(10,Math.max(0,conf)); score=Math.max(0,Math.min(100,score));
    const status:OutRow['status']=score>=80?'valid':score>=60?'ambiguous':'not_found';
    return {status,score,lat,lon,matchLevel,postal,candidates};
}

export async function POST(req: Request) {
    const body = await req.json().catch(() => null) as { rows: InRow[]; defaultCountry?: string; debug?: boolean } | null;
    if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
        return NextResponse.json({ message: 'Body must be { rows: [{address, country?}], defaultCountry?, debug? }' }, { status: 400 });
    }
    const { rows, defaultCountry, debug } = body;
    const ocKey = process.env.OPENCAGE_API_KEY || '';
    let lastNomi = Date.now() - SLEEP_MS_NOMI;
    const out: OutRow[] = [];

    for (const r of rows) {
        const raw = r?.address ?? '';
        const cleaned = autoCleanAddress(raw);
        const country = detectCountry(cleaned, r?.country, defaultCountry);
        const normalized = normalizeAddress(cleaned, country);

        // Nominatim free
        const wait1 = Math.max(0, SLEEP_MS_NOMI - (Date.now() - lastNomi)); if (wait1) await sleep(wait1);
        let nomi:any = await nominatimSearchFree(normalized, { country, debug }); lastNomi = Date.now();

        // retry strip unit
        if (!nomi.best || (nomi.rawArray||[]).length === 0) {
            const stripped = normalized.replace(/\b(Apt|Apartment|Suite|Ste|Unit|Fl|Floor|Lvl|Level|Bldg|Building|Room|Rm)\b\.?\s*([\w\-#]+)/gi,'')
                                      .replace(/\s{2,}/g,' ').replace(/[;,.\s]+$/g,'').trim();
            const wait2 = Math.max(0, SLEEP_MS_NOMI - (Date.now() - lastNomi)); if (wait2) await sleep(wait2);
            const nomi2 = await nominatimSearchFree(stripped, { country, debug }); lastNomi = Date.now();
            if (nomi2 && nomi2.best) nomi = nomi2;
        }

        // US structured
        let usParts:any = null;
        if ((!nomi.best || (nomi.rawArray||[]).length === 0 || matchLevelFromNominatim(nomi.best) === 'unknown') && country === 'US') {
            usParts = parseUS(normalized);
            if (usParts?.street && usParts?.city && usParts?.state) {
                const wait3 = Math.max(0, SLEEP_MS_NOMI - (Date.now() - lastNomi)); if (wait3) await sleep(wait3);
                const nomi3 = await nominatimSearchStructured({
                    street: usParts.street, city: usParts.city, state: usParts.state, postalcode: usParts.zip || '', country: 'US'
                }, { debug }); lastNomi = Date.now();
                if (nomi3 && nomi3.best) nomi = nomi3;
            }
        }

        let result: OutRow;
        if (!nomi.error && nomi.best) {
            const candidates = (nomi.rawArray || []).length;
            const lat = parseFloat(nomi.best.lat); const lon = parseFloat(nomi.best.lon);
            const inputPostal = (usParts && usParts.zip) || String(cleaned||'').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
            const score = computeScore(nomi.matchLevel, nomi.reverseOk, candidates, nomi.postal, country, { inputPostal });
            const status:OutRow['status'] = score >= 80 ? 'valid' : score >= 60 ? 'ambiguous' : 'not_found';
            result = { input_address: raw, cleaned_address: cleaned, normalized_address: normalized, country: country||'',
                       status, score, lat, lon, provider:'nominatim', match_level: nomi.matchLevel, postal_code: nomi.postal||'',
                       notes: `nominatim_candidates=${candidates}${usParts?'; us_structured=1':''}` };
        } else {
            result = { input_address: raw, cleaned_address: cleaned, normalized_address: normalized, country: country||'',
                       status:'error', score:0, provider:'nominatim', notes: nomi.error || 'nominatim_unknown_error' };
        }

        // OpenCage fallback
        if (ocKey && result.score < 80) {
            try {
                const oc:any = await opencageGeocode(normalized, ocKey, country, { debug });
                const inputPostal = (usParts && usParts.zip) || String(cleaned||'').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
                const ocScore = computeScore(oc.matchLevel, true, oc.candidates || 1, oc.postal, country, { inputPostal });
                const ocRes:OutRow = { input_address: raw, cleaned_address: cleaned, normalized_address: normalized, country: country||'',
                    status: ocScore>=80?'valid':ocScore>=60?'ambiguous':'not_found', score: ocScore, lat: oc.lat, lon: oc.lon,
                    provider:'opencage', match_level: oc.matchLevel, postal_code: oc.postal || '', notes:`opencage_candidates=${oc.candidates||1}` };
                result = (result.score >= ocRes.score) ? result : ocRes;
            } catch (e:any) {
                result.notes = (result.notes ? result.notes + '; ' : '') + `opencage_error=${e.message}`;
            }
        }

        out.push(result);
    }

    return NextResponse.json({ data: out });
}
