/* eslint-disable @typescript-eslint/no-explicit-any */
"use client"
import React, { useRef, useState } from 'react';
import Head from 'next/head';
import * as XLSX from 'xlsx';

type LocalRow = { address: string; country?: string };
type VerifyResult = {
    input_address: string;
    cleaned_address: string;
    normalized_address: string;
    country: string;
    status: 'valid' | 'ambiguous' | 'not_found' | 'error';
    score: number;
    lat?: number;
    lon?: number;
    provider: 'nominatim' | 'opencage';
    match_level?: string;
    postal_code?: string;
    notes?: string;
};

export default function Home() {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [fileName, setFileName] = useState<string>('');
    const [error, setError] = useState<string>('');
    const [rows, setRows] = useState<LocalRow[]>([]);
    const [results, setResults] = useState<VerifyResult[]>([]);
    const [isVerifying, setIsVerifying] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });

    const handleSelectClick = () => fileInputRef.current?.click();

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        setError('');
        setRows([]);
        setResults([]);
        setProgress({ done: 0, total: 0 });

        const file = e.target.files?.[0];
        if (!file) { setFileName(''); return; }

        const allowedExt = ['.xlsx', '.xls', '.csv'];
        const lower = file.name.toLowerCase();
        if (!allowedExt.some(ext => lower.endsWith(ext))) {
            setFileName('');
            setError('Vui lòng chọn tệp Excel (.xlsx, .xls) hoặc CSV.');
            e.target.value = '';
            return;
        }

        setFileName(file.name);
        try {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const sheetName = wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
            if (!json.length) {
                setError('File rỗng hoặc không có dữ liệu.');
                return;
            }

            const cols = Object.keys(json[0] || {});
            const addrCol =
                cols.find((c) => ['address', 'địa chỉ', 'dia chi', 'addr'].includes(String(c).toLowerCase())) || cols[0];
            const countryCol = cols.find((c) => ['country', 'quoc gia'].includes(String(c).toLowerCase()));

            const parsed: LocalRow[] = json.map((r) => ({
                address: String(r[addrCol] ?? '').trim(),
                country: countryCol ? String(r[countryCol] ?? '').trim() : undefined,
            })).filter(r => r.address);

            setRows(parsed);
        } catch (err: any) {
            console.error(err);
            setError('Không đọc được file. Hãy kiểm tra định dạng/xem lại nội dung file.');
        }
    };

    const callVerifyApi = async (batch: LocalRow[], defaultCountry?: string) => {
        const r = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: batch, defaultCountry }),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j?.message || r.statusText);
        }
        const j = await r.json();
        return (j?.data || []) as VerifyResult[];
    };

    const verifyAll = async () => {
        if (rows.length === 0) {
            setError('Chưa có dữ liệu để kiểm tra. Vui lòng upload file.');
            return;
        }
        setIsVerifying(true);
        setResults([]);
        setProgress({ done: 0, total: rows.length });

        const BATCH_SIZE = 20; // tuỳ chỉnh theo nhu cầu
        const chunks: LocalRow[][] = [];
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            chunks.push(rows.slice(i, i + BATCH_SIZE));
        }

        try {
            const all: VerifyResult[] = [];
            for (let i = 0; i < chunks.length; i++) {
                const part = chunks[i];
                const partRes = await callVerifyApi(part);
                all.push(...partRes);
                setResults((prev) => [...prev, ...partRes]);
                setProgress({ done: Math.min((i + 1) * BATCH_SIZE, rows.length), total: rows.length });
            }
        } catch (e: any) {
            setError('Lỗi khi verify: ' + e.message);
        } finally {
            setIsVerifying(false);
        }
    };

    const downloadSample = () => {
        window.location.href = '/sample_addresses.xlsx'; // file trong /public
    };

    return (
        <>
            <Head>
                <title>Address Verifier</title>
                <meta name="viewport" content="width=device-width, initial-scale=1" />
            </Head>

            <main style={styles.container}>
                <div style={styles.card}>
                    <h1 style={{ margin: 0, fontSize: 24 }}>Address Verifier</h1>
                    <p style={{ marginTop: 8, color: '#666' }}>
                        Tải lên Excel/CSV có cột address
                    </p>

                    <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button onClick={handleSelectClick} style={styles.uploadBtn}>
                            Upload file Excel
                        </button>
                        <a href="/sample_addresses.xlsx" download style={styles.secondaryBtn}>
                            Tải về Excel mẫu
                        </a>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                            style={{ display: 'none' }}
                            onChange={handleFileChange}
                        />
                        <button onClick={verifyAll} disabled={rows.length === 0 || isVerifying} style={styles.verifyBtn}>
                            {isVerifying ? `Đang kiểm tra… (${progress.done}/${progress.total})` : 'Verify'}
                        </button>
                    </div>

                    {fileName && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6 }}>
                            Đã chọn: <strong>{fileName}</strong> — {rows.length} dòng hợp lệ
                        </div>
                    )}
                    {error && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 6, color: '#cf1322' }}>
                            {error}
                        </div>
                    )}
                    {results.length > 0 && (
                        <div style={{ marginTop: 20 }}>
                            <h3>Kết quả ({results.length}/{progress.total || results.length})</h3>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ borderCollapse: 'collapse', minWidth: 1000, width: '100%' }}>
                                    <thead>
                                        <tr>
                                            <th style={styles.th}>status</th>
                                            <th style={styles.th}>score</th>
                                            <th style={styles.th}>provider</th>
                                            <th style={styles.th}>input_address</th>
                                            <th style={styles.th}>country</th>
                                            <th style={styles.th}>lat</th>
                                            <th style={styles.th}>lon</th>
                                            <th style={styles.th}>postal</th>
                                            <th style={styles.th}>notes</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {results.map((r, i) => (
                                            <tr key={i}>
                                                <td style={styles.td}>{r.status}</td>
                                                <td style={styles.td}>{r.score}</td>
                                                <td style={styles.td}>{r.provider}</td>
                                                <td style={{ ...styles.td, maxWidth: 250, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {r.input_address}
                                                </td>
                                                <td style={styles.td}>{r.country}</td>
                                                <td style={styles.td}>{r.lat ?? ''}</td>
                                                <td style={styles.td}>{r.lon ?? ''}</td>
                                                <td style={styles.td}>{r.postal_code ?? ''}</td>
                                                <td style={{ ...styles.td, maxWidth: 250, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {r.notes ?? ''}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                <footer style={{ marginTop: 24, color: '#999', fontSize: 12 }}>
                    © {new Date().getFullYear()} Address Verifier
                </footer>
            </main>
        </>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#f7f8fa'
    },
    card: {
        width: '100%',
        maxWidth: 1000,
        background: '#fff',
        border: '1px solid #eee',
        borderRadius: 12,
        boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
        padding: 24,
        textAlign: 'left'
    },
    uploadBtn: {
        padding: '10px 16px',
        borderRadius: 8,
        border: '1px solid #1677ff',
        background: '#1677ff',
        color: '#fff',
        fontWeight: 600,
        cursor: 'pointer'
    },
    verifyBtn: {
        padding: '10px 16px',
        borderRadius: 8,
        border: '1px solid #52c41a',
        background: '#52c41a',
        color: '#fff',
        fontWeight: 600,
        cursor: 'pointer'
    },
    secondaryBtn: {
        display: 'inline-block',
        padding: '10px 16px',
        borderRadius: 8,
        border: '1px solid #d9d9d9',
        background: '#fff',
        color: '#333',
        fontWeight: 600,
        textDecoration: 'none',
        cursor: 'pointer'
    },
    th: {
        border: '1px solid #999',
        padding: '5px',
        textAlign: 'center',
        background: '#f2f2f2',
        fontWeight: 600
    },
    td: {
        border: '1px solid #ccc',
        padding: '5px',
        textAlign: 'left',
        verticalAlign: 'top'
    }
};
