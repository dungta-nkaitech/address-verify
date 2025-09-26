/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import * as XLSX from "xlsx";

// Kiểu dữ liệu input lấy từ Excel
type LocalRow = {
  SHIPPINGADDRESS: string;
  SHIPPINGCITY?: string;
  SHIPPINGZIPCODE?: string;
  SHIPPINGPROVINCE?: string;
  SHIPPINGCOUNTRY?: string;
};

type VerifyResult = {
  input_address: string;
  cleaned_address: string;
  normalized_address: string;
  country: string;
  status: "valid" | "ambiguous" | "not_found" | "error";
  score: number;
  lat?: number;
  lon?: number;
  provider: "nominatim" | "opencage";
  match_level?: string;
  postal_code?: string;
  notes?: string;
};

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // UI state
  const [fileName, setFileName] = useState<string>("");
  const [driveLink, setDriveLink] = useState<string>("");
  const [error, setError] = useState<string>("");

  // Data state
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [results, setResults] = useState<VerifyResult[]>([]);

  // Progress state
  const [isVerifying, setIsVerifying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const handleSelectClick = () => fileInputRef.current?.click();

  // ========= Helpers =========
  function extractDriveFileId(input: string): string | null {
    const s = input.trim();
    const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m1) return m1[1];
    const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m2) return m2[1];
    if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // plain id
    return null;
  }
  function extractSheetId(input: string): string | null {
    const m = input.trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  async function getRowsFromArrayBuffer(buf: ArrayBuffer): Promise<LocalRow[]> {
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
    return json
      .map((r) => ({
        SHIPPINGADDRESS: String(r["SHIPPINGADDRESS"] ?? "").trim(),
        SHIPPINGCITY: String(r["SHIPPINGCITY"] ?? "").trim(),
        SHIPPINGZIPCODE: String(r["SHIPPINGZIPCODE"] ?? "").trim(),
        SHIPPINGPROVINCE: String(r["SHIPPINGPROVINCE"] ?? "").trim(),
        SHIPPINGCOUNTRY: String(r["SHIPPINGCOUNTRY"] ?? "").trim(),
      }))
      .filter((r) => r.SHIPPINGADDRESS);
  }

  // ========= Local upload =========
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Nếu user chọn file → xóa link Drive (chỉ 1 nguồn)
    setDriveLink("");
    setError("");
    setResults([]);
    setProgress({ done: 0, total: 0 });

    const file = e.target.files?.[0];
    if (!file) {
      setFileName("");
      setRows([]);
      return;
    }

    const allowedExt = [".xlsx", ".xls", ".csv"];
    const lower = file.name.toLowerCase();
    if (!allowedExt.some((ext) => lower.endsWith(ext))) {
      setFileName("");
      setRows([]);
      setError("Vui lòng chọn tệp Excel (.xlsx, .xls) hoặc CSV.");
      e.target.value = "";
      return;
    }

    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await getRowsFromArrayBuffer(buf);
      if (parsed.length === 0) {
        setError("File rỗng hoặc không có dữ liệu hợp lệ.");
      }
      setRows(parsed);
    } catch (err: any) {
      console.error(err);
      setRows([]);
      setError("Không đọc được file. Hãy kiểm tra định dạng/nội dung file.");
    } finally{
        e.target.value = "";
    }
  };

  // ========= Check từ link Google (Sheets/Drive) =========
  const checkDriveLink = async () => {
    setError("");
    setResults([]);
    setProgress({ done: 0, total: 0 });

    // Khi user dùng link → xóa file upload (chỉ 1 nguồn)
    setFileName("");

    const sheetId = extractSheetId(driveLink);
    let url = "";
    if (sheetId) {
      // Google Sheets → export ra .xlsx
      url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
    } else {
      // File Excel trên Drive
      const fileId = extractDriveFileId(driveLink);
      if (fileId) {
        url = `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }

    if (!url) {
      setRows([]);
      setError("Không nhận diện được link Google Drive/Sheets hợp lệ.");
      return;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await (await res.blob()).arrayBuffer();
      const parsed = await getRowsFromArrayBuffer(buf);
      if (parsed.length === 0) {
        setRows([]);
        setError("Không tìm thấy dòng hợp lệ trong file.");
        return;
      }
      setRows(parsed);
      setFileName(
        `Google ${sheetId ? "Sheets" : "Drive"}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRows([]);
      setError("Không thể đọc file từ Google: " + msg);
    }
  };

  // ========= Gọi API verify =========
  const callVerifyApi = async (batch: LocalRow[]) => {
    const r = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: batch }),
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
      setError("Chưa có dữ liệu để kiểm tra. Vui lòng upload file hoặc nhập link và nhấn Check trước.");
      return;
    }
    setIsVerifying(true);
    setResults([]);
    setProgress({ done: 0, total: rows.length });

    const BATCH_SIZE = 20; // điều chỉnh theo nhu cầu/giới hạn
    const chunks: LocalRow[][] = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      chunks.push(rows.slice(i, i + BATCH_SIZE));
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        const part = chunks[i];
        const partRes = await callVerifyApi(part);
        setResults((prev) => [...prev, ...partRes]);
        setProgress({
          done: Math.min((i + 1) * BATCH_SIZE, rows.length),
          total: rows.length,
        });
      }
    } catch (e: any) {
      setError("Lỗi khi verify: " + e.message);
    } finally {
      setIsVerifying(false);
    }
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
          <p style={{ marginTop: 8, color: "#666" }}>
            Upload Excel/CSV có cột{" "}
            <code>SHIPPINGADDRESS, SHIPPINGCITY, SHIPPINGZIPCODE, SHIPPINGPROVINCE, SHIPPINGCOUNTRY</code>{" "}
            hoặc dán link Google Drive/Google Sheets (public).
          </p>

          {/* Hàng nút upload + tải mẫu */}
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
          </div>

          {/* Link Google + Check */}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              value={driveLink}
              onChange={(e) => {
                const v = e.target.value;
                setDriveLink(v);
                if (v.trim()) {
                  // Nếu user nhập link → clear dữ liệu từ file upload
                  setFileName("");
                  setRows([]);
                  setResults([]);
                  setError("");
                }
              }}
              placeholder="Dán link Google Drive/Google Sheets (công khai)"
              style={{
                flex: "1 1 420px",
                minWidth: 320,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #d9d9d9",
                outline: "none",
              }}
            />
            <button onClick={checkDriveLink} style={styles.secondaryBtn}>
              Check
            </button>
          </div>

          {/* Thông báo trạng thái sau khi Check */}
          {(fileName || error) && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                background: error ? "#fff1f0" : "#f6ffed",
                border: `1px solid ${error ? "#ffa39e" : "#b7eb8f"}`,
                borderRadius: 6,
                color: error ? "#cf1322" : "inherit",
              }}
            >
              {error ? error : (
                <>
                  Đã chọn: <strong>{fileName}</strong>{" "}
                  {rows.length ? <>— <strong>{rows.length}</strong> dòng hợp lệ</> : null}
                </>
              )}
            </div>
          )}

          {/* Nút Verify đặt NGAY DƯỚI phần thông báo */}
          {rows.length > 0 && !error && (
            <div style={{ marginTop: 12 }}>
              <button
                onClick={verifyAll}
                disabled={isVerifying}
                style={styles.verifyBtn}
              >
                {isVerifying ? (
                  <>
                    Verifing<LoadingDots /> ({progress.done}/{progress.total})
                  </>
                ) : (
                  "Verify"
                )}
              </button>
            </div>
          )}

          {/* Kết quả */}
          {results.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3>
                Kết quả ({results.length}/{progress.total || results.length})
              </h3>
              <div style={{ height: 4, background: "#f0f0f0", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                {isVerifying && (
                  <div
                    style={{
                      width: `${(progress.done / Math.max(progress.total, 1)) * 100}%`,
                      height: "100%",
                      background: "#1677ff",
                      transition: "width 0.3s ease",
                    }}
                  />
                )}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", minWidth: 1000, width: "100%" }}>
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
                      <tr key={i} style={{ background: i % 2 ? "#fafafa" : "transparent" }}>
                        <td style={styles.td}>
                          {r.status === "valid" ? "✅" : r.status === "ambiguous" ? "⚠️" : r.status === "not_found" ? "❌" : "⛔"} {r.status}
                        </td>
                        <td style={styles.td}>{r.score}</td>
                        <td style={styles.td}>{r.provider}</td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>{r.input_address}</td>
                        <td style={styles.td}>{r.country}</td>
                        <td style={styles.td}>{r.lat ?? ""}</td>
                        <td style={styles.td}>{r.lon ?? ""}</td>
                        <td style={styles.td}>{r.postal_code ?? ""}</td>
                        <td
                          style={{
                            ...styles.td,
                            maxWidth: 280,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={r.notes ?? ""}
                        >
                          {r.notes ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <footer style={{ marginTop: 24, color: "#999", fontSize: 12 }}>
          © {new Date().getFullYear()} Address Verifier by dungta
        </footer>
      </main>
    </>
  );
}

/** Dấu chấm động khi loading (… → .. → . → …) */
function LoadingDots() {
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d + 1) % 4), 400);
    return () => clearInterval(t);
  }, []);
  const text = useMemo(() => ".".repeat(dots || 1), [dots]); // luôn có ít nhất 1 chấm
  return <span style={{ display: "inline-block", width: 18, textAlign: "left" }}>{text}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "#f7f8fa",
  },
  card: {
    width: "100%",
    maxWidth: 1000,
    background: "#fff",
    border: "1px solid #eee",
    borderRadius: 12,
    boxShadow: "0 4px 20px rgba(0,0,0,0.04)",
    padding: 24,
    textAlign: "left",
  },
  uploadBtn: {
    padding: "10px 16px",
    borderRadius: 8,
    border: "1px solid #1677ff",
    background: "#1677ff",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  verifyBtn: {
    padding: "10px 16px",
    borderRadius: 8,
    border: "1px solid #52c41a",
    background: "#52c41a",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryBtn: {
    display: "inline-block",
    padding: "10px 16px",
    borderRadius: 8,
    border: "1px solid #d9d9d9",
    background: "#fff",
    color: "#333",
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  },
  th: {
    border: "1px solid #999",
    padding: "5px",
    textAlign: "center",
    background: "#f2f2f2",
    fontWeight: 600,
  },
  td: {
    border: "1px solid #ccc",
    padding: "5px",
    textAlign: "left",
    verticalAlign: "top",
  },
};