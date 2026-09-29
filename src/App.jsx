import React, { useState, useEffect, useCallback } from 'react';
import {
  PlusCircle, History, Save, Trash2, Edit3, Download,
  Clock, User, Hash, Package, DollarSign, Lock, Unlock,
  X, Check, Bell, Sun, Moon, UploadCloud, LogOut,
  ChevronLeft, ChevronRight, Target, CalendarRange
} from 'lucide-react';

// --- SUPABASE AUTH + DATA ---
import { getCurrentSession, signInWithPassword, signOut, onAuthStateChange, fetchProfile } from './lib/auth';
import { fetchJobsForPeriod, countAllJobs, insertJob, updateJob, deleteJob, insertMigrationRows, insertLegacyMigrationRows } from './lib/laserJobs';
import { fetchMonthlyTarget, upsertMonthlyTarget } from './lib/monthlyTargets';
import { currentYearMonth, shiftYearMonth, formatYearMonth, resolvePeriodRange } from './lib/period';
import { computeStats, computeProgress } from './lib/stats';

// --- CSV MIGRATION TRANSPORT (export/import validation, lossless round trip) ---
import { exportJobsToCsv, parseImportCsv, parseLegacyImportCsv } from './lib/csvMigration';

function computeDefaultPrice(qty) {
  if (qty >= 10 && qty <= 50) return 35000;
  if (qty > 50) return 25000;
  return 50000;
}

const App = () => {
  const [activeTab, setActiveTab] = useState('input');
  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [totalJobsCount, setTotalJobsCount] = useState(null);

  // --- Period filter state (Part A) ---
  // mode: 'monthly' | 'custom' | 'all'. Defaults to the current local
  // calendar month, per spec.
  const [period, setPeriod] = useState(() => {
    const { year, month } = currentYearMonth();
    return { mode: 'monthly', year, month, startDate: '', endDate: '' };
  });
  const [customRangeError, setCustomRangeError] = useState('');

  // --- Monthly target state (Part B) ---
  const [monthlyTarget, setMonthlyTarget] = useState(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [showTargetEditor, setShowTargetEditor] = useState(false);
  const [targetForm, setTargetForm] = useState({ revenueTarget: '', unitTarget: '' });
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState('');

  // --- Auth state ---
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginSubmitting, setLoginSubmitting] = useState(false);

  const [notification, setNotification] = useState({ show: false, message: '', type: 'info' });
  const [editingJob, setEditingJob] = useState(null);
  const [jobToDelete, setJobToDelete] = useState(null);

  // State Form Input
  const [formData, setFormData] = useState({
    tanggal: new Date().toISOString().split('T')[0],
    operator: '',
    invoice_code: '',
    customer: '',
    deskripsi: '',
    jumlah_unit: 1,
    harga_per_unit: 50000,
    durasi_menit: 10
  });

  // Mode Gelap
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('theme') === 'dark';
    return false;
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  const notify = (message, type = 'info') => {
    setNotification({ show: true, message, type });
    setTimeout(() => setNotification({ show: false, message: '', type: 'info' }), 3000);
  };

  // --- SUPABASE: SESSION RESTORATION + AUTH STATE LISTENER ---
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const current = await getCurrentSession();
        if (!cancelled) setSession(current);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    }
    restore();

    const unsubscribe = onAuthStateChange((nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setJobs([]);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // --- Load the authorized role from public.profiles once a session exists ---
  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    async function loadProfile() {
      try {
        const data = await fetchProfile(session.user.id);
        if (!cancelled) setProfile(data);
        if (!cancelled && !data) {
          notify('Profil pengguna tidak ditemukan — hubungi admin.', 'error');
        }
      } catch (err) {
        if (!cancelled) notify('Gagal memuat profil: ' + err.message, 'error');
      }
    }
    loadProfile();

    return () => { cancelled = true; };
  }, [session]);

  const isAdmin = profile?.role === 'admin';

  // Loads jobs for the currently selected period (KPI cards + Log Produksi
  // table always show the SAME period — never let the table lag on
  // all-time data while KPI cards are filtered).
  const loadJobs = useCallback(async (currentPeriod) => {
    setJobsLoading(true);
    setCustomRangeError('');
    try {
      const range = resolvePeriodRange(currentPeriod);
      const data = await fetchJobsForPeriod(range);
      setJobs(data);
    } catch (err) {
      if (currentPeriod.mode === 'custom') {
        setCustomRangeError(err.message);
        setJobs([]);
      } else {
        notify('Gagal mengambil data: ' + err.message, 'error');
      }
    } finally {
      setJobsLoading(false);
    }
  }, []);

  const refreshTotalJobsCount = useCallback(async () => {
    try {
      setTotalJobsCount(await countAllJobs());
    } catch {
      // Non-critical (only gates the one-time legacy import button) — ignore.
    }
  }, []);

  // --- SUPABASE: FETCH DATA once authenticated, and whenever the period changes ---
  useEffect(() => {
    if (!session) return;
    loadJobs(period);
  }, [session, period, loadJobs]);

  useEffect(() => {
    if (!session) return;
    refreshTotalJobsCount();
  }, [session, refreshTotalJobsCount]);

  // --- Monthly target: meaningful only in Monthly mode (Part B) ---
  useEffect(() => {
    if (!session || period.mode !== 'monthly') {
      setMonthlyTarget(null);
      return;
    }
    let cancelled = false;
    setTargetLoading(true);
    fetchMonthlyTarget(period.year, period.month)
      .then((data) => { if (!cancelled) setMonthlyTarget(data); })
      .catch((err) => { if (!cancelled) notify('Gagal memuat target: ' + err.message, 'error'); })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [session, period.mode, period.year, period.month]);

  const goToPreviousMonth = () => {
    setPeriod((prev) => {
      if (prev.mode !== 'monthly') return prev;
      const { year, month } = shiftYearMonth(prev.year, prev.month, -1);
      return { ...prev, year, month };
    });
  };

  const goToNextMonth = () => {
    setPeriod((prev) => {
      if (prev.mode !== 'monthly') return prev;
      const { year, month } = shiftYearMonth(prev.year, prev.month, 1);
      return { ...prev, year, month };
    });
  };

  const openTargetEditor = () => {
    setTargetForm({
      revenueTarget: monthlyTarget?.revenue_target ?? '',
      unitTarget: monthlyTarget?.unit_target ?? '',
    });
    setTargetError('');
    setShowTargetEditor(true);
  };

  const handleSaveTarget = async (e) => {
    e.preventDefault();
    if (period.mode !== 'monthly') return;
    const { revenueTarget, unitTarget } = targetForm;
    if (revenueTarget !== '' && Number(revenueTarget) < 0) {
      setTargetError('Target revenue tidak boleh negatif.');
      return;
    }
    if (unitTarget !== '' && Number(unitTarget) < 0) {
      setTargetError('Target unit tidak boleh negatif.');
      return;
    }
    setTargetSaving(true);
    setTargetError('');
    try {
      const data = await upsertMonthlyTarget(period.year, period.month, targetForm);
      setMonthlyTarget(data);
      setShowTargetEditor(false);
      notify('Target bulan ini disimpan', 'success');
    } catch (err) {
      setTargetError('Gagal simpan target: ' + err.message);
    } finally {
      setTargetSaving(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginSubmitting(true);
    setLoginError('');
    try {
      await signInWithPassword(loginEmail, loginPassword);
      setLoginEmail('');
      setLoginPassword('');
      notify('Berhasil masuk', 'success');
    } catch {
      setLoginError('Email atau password salah.');
    } finally {
      setLoginSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      notify('Berhasil keluar', 'success');
    } catch (err) {
      notify('Gagal keluar: ' + err.message, 'error');
    }
  };

  const handleQtyChange = (value) => {
    const qty = parseInt(value) || 0;
    setFormData(prev => ({ ...prev, jumlah_unit: value, harga_per_unit: computeDefaultPrice(qty) }));
  };

  // --- SUPABASE: SIMPAN DATA BARU ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await insertJob(formData);
      notify('Job berhasil disimpan!', 'success');
      setFormData({ ...formData, invoice_code: '', customer: '', deskripsi: '', jumlah_unit: 1, harga_per_unit: 50000 });
      await loadJobs(period);
      await refreshTotalJobsCount();
    } catch (err) {
      notify('Gagal simpan: ' + err.message, 'error');
    }
  };

  // --- SUPABASE: UPDATE DATA ---
  const handleUpdateJob = async (e) => {
    e.preventDefault();
    if (!editingJob || !isAdmin) return;

    try {
      await updateJob(editingJob.id, editingJob);
      notify('Data berhasil diperbarui!', 'success');
      setEditingJob(null);
      await loadJobs(period);
    } catch (err) {
      notify('Gagal update: ' + err.message, 'error');
    }
  };

  // --- SUPABASE: HAPUS DATA ---
  const confirmDelete = async () => {
    if (!isAdmin || !jobToDelete) return;
    try {
      await deleteJob(jobToDelete);
      notify('Data dihapus', 'success');
      setJobToDelete(null);
      await loadJobs(period);
      await refreshTotalJobsCount();
    } catch (err) {
      notify('Gagal hapus: ' + err.message, 'error');
    }
  };

  // --- FITUR MIGRASI: IMPORT CSV KE SUPABASE ---
  // Pre-flight pipeline (parse -> validate headers -> validate every row ->
  // check duplicates) happens entirely in parseImportCsv before any write.
  // If any row is invalid or any duplicate legacy_firebase_id is detected, ZERO
  // records are written. Each chunk sent to Supabase is one atomic INSERT
  // statement; a file that fits in a single chunk is fully atomic. A file
  // split across multiple chunks is NOT atomic end-to-end — see
  // insertMigrationRows in src/lib/laserJobs.js.
  const handleCSVImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target.result;

      // Duplicate-legacy_firebase_id detection must run against the FULL
      // history, never just the currently filtered period — otherwise a
      // narrower period filter would silently let duplicates through.
      let allJobs;
      try {
        allJobs = await fetchJobsForPeriod({ mode: 'all' });
      } catch (err) {
        notify('Gagal memuat data lengkap untuk cek duplikat: ' + err.message, 'error');
        e.target.value = null;
        return;
      }
      const result = parseImportCsv(text, allJobs);

      if (!result.ok) {
        console.error('Import CSV Migrasi dibatalkan:', result);
        if (result.stage === 'headers') {
          notify(`Import dibatalkan: kolom wajib hilang (${result.headerErrors.join(', ')})`, 'error');
        } else if (result.stage === 'validation') {
          notify(`Import dibatalkan: 0 data ditulis, ${result.rowErrors.length} baris tidak valid — lihat console`, 'error');
        } else if (result.stage === 'duplicates') {
          notify(`Import dibatalkan: ${result.duplicateErrors.length} duplikat legacy_firebase_id terdeteksi — lihat console`, 'error');
        } else {
          notify(`Import dibatalkan: ${result.message}`, 'error');
        }
        e.target.value = null;
        return;
      }

      try {
        const summary = await insertMigrationRows(result.rows);
        if (summary.failed > 0) {
          console.error('Sebagian migrasi gagal ditulis:', summary.failedChunks);
          notify(
            `Imported: ${summary.inserted} | Gagal: ${summary.failed}` +
              (summary.chunked ? ' (tidak sepenuhnya atomik — lihat console)' : ''),
            'error'
          );
        } else {
          notify(`Imported: ${summary.inserted} records | Rejected: 0`, 'success');
        }
        await loadJobs(period);
        await refreshTotalJobsCount();
      } catch (err) {
        console.error('Gagal menulis migrasi ke Supabase', err);
        notify(`Gagal migrasi: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // --- ONE-TIME LEGACY IMPORT: 9-column pre-canonical Firebase export ---
  // No document ID and no original created_at exist in this format, so
  // legacy_firebase_id stays NULL and created_at is left to Postgres' own
  // default — that loss of historical accuracy is disclosed in the success
  // message, never silently absorbed. Requires an empty laser_jobs table
  // (enforced live in insertLegacyMigrationRows) and writes in a single
  // atomic INSERT — parseLegacyImportCsv rejects files over the 500-row cap
  // outright rather than chunking, so this import is always all-or-nothing.
  const handleLegacyCSVImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target.result;
      const result = parseLegacyImportCsv(text);

      if (!result.ok) {
        console.error('Import CSV Legacy dibatalkan:', result);
        if (result.stage === 'headers') {
          notify(`Import legacy dibatalkan: format tidak dikenali (kolom hilang: ${result.headerErrors.join(', ')})`, 'error');
        } else if (result.stage === 'size') {
          notify(`Import legacy dibatalkan: ${result.message}`, 'error');
        } else if (result.stage === 'validation') {
          notify(`Import legacy dibatalkan: 0 data ditulis, ${result.rowErrors.length} baris tidak valid — lihat console`, 'error');
        } else {
          notify(`Import legacy dibatalkan: ${result.message}`, 'error');
        }
        e.target.value = null;
        return;
      }

      try {
        const summary = await insertLegacyMigrationRows(result.rows);
        notify(
          `Legacy imported: ${summary.inserted} records. Catatan: created_at asli tidak tersedia di format ini — diisi waktu import.`,
          'success'
        );
        await loadJobs(period);
        await refreshTotalJobsCount();
      } catch (err) {
        console.error('Gagal menulis import legacy ke Supabase', err);
        notify(`Gagal import legacy: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // Canonical, lossless CSV transport: includes legacy_firebase_id + created_at
  // and uses RFC 4180 quoting (via csvMigration.exportJobsToCsv) so commas,
  // quotes and newlines inside customer/deskripsi survive the round trip.
  // Exports the FULL history regardless of the active period filter — this
  // is a migration/backup transport, not a period report, so its behavior
  // stays identical to the pre-period-filter app.
  const exportCSV = async () => {
    try {
      const allJobs = await fetchJobsForPeriod({ mode: 'all' });
      const csvContent = exportJobsToCsv(allJobs);
      const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `Laporan_Laser_CG_${new Date().toLocaleDateString()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      notify('Data siap diunduh!', 'success');
    } catch (err) {
      notify('Gagal export: ' + err.message, 'error');
    }
  };

  // Selected-period KPIs (Part A). See lib/stats.js for the validated formulas.
  const stats = computeStats(jobs);

  // Target progress is meaningful only in Monthly mode (Part B). Percentage
  // is never clamped — only the visual bar width is capped at 100%.
  const revenueTargetValue = monthlyTarget?.revenue_target != null ? Number(monthlyTarget.revenue_target) : null;
  const unitTargetValue = monthlyTarget?.unit_target != null ? Number(monthlyTarget.unit_target) : null;
  const revenueProgress = period.mode === 'monthly' ? computeProgress(stats.income, revenueTargetValue) : null;
  const unitProgress = period.mode === 'monthly' ? computeProgress(stats.units, unitTargetValue) : null;

  // --- Auth gate: restoring session ---
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <p className="text-slate-400 dark:text-slate-500 text-sm italic font-medium tracking-widest">Memuat sesi...</p>
      </div>
    );
  }

  // --- Auth gate: no session, show login only. No dashboard/history is rendered. ---
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans flex items-center justify-center p-4 transition-colors duration-300">
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-sm w-full shadow-2xl relative overflow-hidden transition-colors">
          <div className="absolute top-0 left-0 w-full h-2 bg-yellow-400 dark:bg-yellow-500"></div>
          <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-3 mb-2 mt-2">
            <span className="bg-yellow-400 dark:bg-yellow-500 p-2.5 rounded-2xl text-white dark:text-slate-900 shadow-lg shadow-yellow-200 dark:shadow-none">⚡</span>
            CG Digital Print
          </h1>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-8 font-medium leading-relaxed uppercase tracking-widest text-center">Masuk untuk melanjutkan</p>
          <form onSubmit={handleLogin}>
            <input
              type="email" required autoFocus placeholder="Email"
              value={loginEmail} onChange={(e) => { setLoginEmail(e.target.value); setLoginError(''); }}
              className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all mb-4 font-bold text-slate-800 dark:text-white"
            />
            <input
              type="password" required placeholder="Password"
              value={loginPassword} onChange={(e) => { setLoginPassword(e.target.value); setLoginError(''); }}
              className="w-full p-5 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all mb-4 text-center font-black text-lg tracking-widest text-slate-800 dark:text-white"
            />
            {loginError && <p className="text-red-500 text-[10px] font-bold text-center mb-4 uppercase tracking-wider">{loginError}</p>}
            <button type="submit" disabled={loginSubmitting} className="w-full bg-slate-900 dark:bg-yellow-500 text-white dark:text-slate-900 font-black py-5 rounded-2xl shadow-xl dark:shadow-none transition-all active:scale-95 uppercase tracking-widest text-sm disabled:opacity-60">
              {loginSubmitting ? 'Memproses...' : 'Masuk'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans p-4 md:p-8 pb-20 transition-colors duration-300">

      {notification.show && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-6 py-4 rounded-2xl shadow-2xl ${notification.type === 'error' ? 'bg-red-600' : 'bg-slate-800 dark:bg-slate-100'} text-white dark:text-slate-900 animate-bounce`}>
          <Bell size={20} className={notification.type === 'error' ? 'text-white' : (isDark ? "text-yellow-600" : "text-yellow-400")} />
          <span className="font-bold text-sm tracking-wide">{notification.message}</span>
        </div>
      )}

      <div className="max-w-6xl mx-auto mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-3 transition-colors duration-300">
            <span className="bg-yellow-400 dark:bg-yellow-500 p-2.5 rounded-2xl text-white dark:text-slate-900 shadow-lg shadow-yellow-200 dark:shadow-none">⚡</span>
            CG Digital Print
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2 font-medium transition-colors">Monitoring Fiber Laser — Karawang Warehouse</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsDark(!isDark)}
            className="p-3 rounded-2xl flex items-center justify-center font-bold transition-all shadow-sm border bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            {isDark ? <Sun size={20} className="text-yellow-400" /> : <Moon size={20} />}
          </button>

          <div className={`p-3 rounded-2xl flex items-center gap-2 font-bold shadow-sm border ${isAdmin ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/50' : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-300 border-slate-200 dark:border-slate-700'}`}>
            {isAdmin ? <Unlock size={20} /> : <Lock size={20} />}
            <span className="text-xs uppercase tracking-tighter font-black hidden sm:block">{isAdmin ? "Admin Active" : "Read Only"}</span>
          </div>

          <button
            onClick={handleLogout}
            title="Keluar"
            className="p-3 rounded-2xl flex items-center gap-2 font-bold transition-all shadow-sm border bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            <LogOut size={20} />
          </button>

          <div className="flex bg-white dark:bg-slate-800 p-1.5 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 transition-colors">
            <button
              onClick={() => setActiveTab('input')}
              className={`px-6 py-2.5 rounded-xl flex items-center gap-2 font-bold transition-all ${activeTab === 'input' ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-lg' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
            >
              <PlusCircle size={18} /> <span className="hidden sm:block">Input</span>
            </button>
            <button
              onClick={() => setActiveTab('report')}
              className={`px-6 py-2.5 rounded-xl flex items-center gap-2 font-bold transition-all ${activeTab === 'report' ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-lg' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
            >
              <History size={18} /> <span className="hidden sm:block">Riwayat</span>
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto">
        {/* --- PERIOD FILTER (Part A) --- */}
        <div className="bg-white dark:bg-slate-900 p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 mb-6 flex flex-col md:flex-row md:items-center gap-4 transition-colors">
          <div className="flex bg-slate-50 dark:bg-slate-950 p-1.5 rounded-2xl shrink-0">
            {[
              { key: 'monthly', label: 'Bulanan' },
              { key: 'custom', label: 'Rentang Kustom' },
              { key: 'all', label: 'Semua Waktu' },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => setPeriod((prev) => {
                  if (opt.key === 'monthly') {
                    const { year, month } = prev.mode === 'monthly' ? prev : currentYearMonth();
                    return { ...prev, mode: 'monthly', year, month };
                  }
                  return { ...prev, mode: opt.key };
                })}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all ${period.mode === opt.key ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-md' : 'text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {period.mode === 'monthly' && (
            <div className="flex items-center gap-2">
              <button onClick={goToPreviousMonth} className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                <ChevronLeft size={18} />
              </button>
              <span className="px-4 py-2 font-black text-sm text-slate-800 dark:text-white min-w-[160px] text-center">
                {formatYearMonth(period.year, period.month)}
              </span>
              <button onClick={goToNextMonth} className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                <ChevronRight size={18} />
              </button>
            </div>
          )}

          {period.mode === 'custom' && (
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
              <div className="flex items-center gap-2">
                <CalendarRange size={16} className="text-slate-400" />
                <input
                  type="date" value={period.startDate}
                  onChange={(e) => setPeriod((prev) => ({ ...prev, startDate: e.target.value }))}
                  className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-xl border-none outline-none focus:ring-2 focus:ring-yellow-400 font-bold text-sm text-slate-700 dark:text-slate-200 color-scheme-light dark:color-scheme-dark"
                />
                <span className="text-slate-400 text-xs font-bold">s/d</span>
                <input
                  type="date" value={period.endDate}
                  onChange={(e) => setPeriod((prev) => ({ ...prev, endDate: e.target.value }))}
                  className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-xl border-none outline-none focus:ring-2 focus:ring-yellow-400 font-bold text-sm text-slate-700 dark:text-slate-200 color-scheme-light dark:color-scheme-dark"
                />
              </div>
              {customRangeError && (!period.startDate || !period.endDate ? null : (
                <span className="text-red-500 text-[10px] font-bold uppercase tracking-wide">{customRangeError}</span>
              ))}
            </div>
          )}

          {isAdmin && period.mode === 'monthly' && (
            <button
              onClick={openTargetEditor}
              className="md:ml-auto px-4 py-2.5 bg-yellow-50 hover:bg-yellow-100 dark:bg-yellow-900/20 dark:hover:bg-yellow-800/40 text-yellow-700 dark:text-yellow-400 rounded-xl text-xs font-black flex items-center gap-2 transition-all shrink-0"
            >
              <Target size={16} /> {targetLoading ? 'Memuat...' : (monthlyTarget ? 'Edit Target' : 'Set Target')}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white dark:bg-slate-900 p-7 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 flex items-center gap-5 hover:shadow-md transition-all">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/30 rounded-2xl text-emerald-600 dark:text-emerald-400"><DollarSign size={28} /></div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Total Pemasukan</p>
              <p className="text-2xl font-black text-slate-800 dark:text-white">Rp {stats.income.toLocaleString()}</p>
              {period.mode === 'monthly' && (
                revenueProgress != null ? (
                  <div className="mt-2">
                    <div className="flex justify-between text-[9px] font-bold text-slate-400 dark:text-slate-500 mb-1">
                      <span>Target Rp {revenueTargetValue.toLocaleString()}</span>
                      <span className={revenueProgress >= 100 ? 'text-emerald-600 dark:text-emerald-400' : ''}>{revenueProgress.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(revenueProgress, 100)}%` }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest mt-1">No target set</p>
                )
              )}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 p-7 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 flex items-center gap-5 hover:shadow-md transition-all">
            <div className="p-4 bg-blue-50 dark:bg-blue-900/30 rounded-2xl text-blue-600 dark:text-blue-400"><Package size={28} /></div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Unit Terproduksi</p>
              <p className="text-2xl font-black text-slate-800 dark:text-white">{stats.units.toLocaleString()} <span className="text-sm font-normal text-slate-400">Pcs</span></p>
              {period.mode === 'monthly' && (
                unitProgress != null ? (
                  <div className="mt-2">
                    <div className="flex justify-between text-[9px] font-bold text-slate-400 dark:text-slate-500 mb-1">
                      <span>Target {unitTargetValue.toLocaleString()} pcs</span>
                      <span className={unitProgress >= 100 ? 'text-blue-600 dark:text-blue-400' : ''}>{unitProgress.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(unitProgress, 100)}%` }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest mt-1">No target set</p>
                )
              )}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 p-7 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 flex items-center gap-5 hover:shadow-md transition-all">
            <div className="p-4 bg-purple-50 dark:bg-purple-900/30 rounded-2xl text-purple-600 dark:text-purple-400"><Clock size={28} /></div>
            <div>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Runtime Mesin Total</p>
              <p className="text-2xl font-black text-slate-800 dark:text-white">{stats.duration.toLocaleString()} <span className="text-sm font-normal text-slate-400">m</span></p>
            </div>
          </div>
        </div>

        {activeTab === 'input' ? (
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden relative transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-yellow-400 dark:bg-yellow-500"></div>
            <div className="p-8 border-b border-slate-50 dark:border-slate-800/50 bg-slate-50/30 dark:bg-slate-800/20 flex justify-between items-center mt-2">
              <h2 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">📝 Input Job Antrian</h2>
              <div className="flex gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-200 dark:bg-slate-700"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-slate-200 dark:bg-slate-700"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 dark:bg-yellow-500"></span>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="p-10 grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-8">
              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Tanggal Produksi</label>
                  <input type="date" value={formData.tanggal} onChange={e => setFormData({ ...formData, tanggal: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all font-bold text-slate-700 dark:text-slate-200 color-scheme-light dark:color-scheme-dark" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Nama Operator</label>
                  <input type="text" required placeholder="Contoh: Budi" value={formData.operator} onChange={e => setFormData({ ...formData, operator: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all font-bold text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Invoice Code</label>
                  <input type="text" placeholder="INV/CG/..." value={formData.invoice_code} onChange={e => setFormData({ ...formData, invoice_code: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Nama Customer</label>
                  <input type="text" placeholder="Nama PT / Individu" value={formData.customer} onChange={e => setFormData({ ...formData, customer: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600" />
                </div>
              </div>
              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Deskripsi Kerja</label>
                  <input type="text" placeholder="Contoh: Grafir Lensa Kacamata" value={formData.deskripsi} onChange={e => setFormData({ ...formData, deskripsi: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600" />
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Volume (Pcs)</label>
                    <input type="number" min="1" value={formData.jumlah_unit} onChange={e => handleQtyChange(e.target.value)} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all font-bold text-slate-900 dark:text-slate-100" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Durasi/Pcs (m)</label>
                    <input type="number" min="0" value={formData.durasi_menit} onChange={e => setFormData({ ...formData, durasi_menit: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all font-bold text-slate-900 dark:text-slate-100" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Harga Jasa/Pcs (IDR)</label>
                  <div className="relative">
                    <div className="absolute left-4 top-4.5 text-slate-400 dark:text-slate-500 font-bold text-sm">Rp</div>
                    <input type="number" value={formData.harga_per_unit} onChange={e => setFormData({ ...formData, harga_per_unit: e.target.value })} className="w-full pl-12 p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 font-black text-slate-800 dark:text-slate-100" />
                  </div>
                </div>
                <div className="pt-6">
                  <button type="submit" className="w-full bg-slate-900 dark:bg-yellow-500 hover:bg-black dark:hover:bg-yellow-400 text-white dark:text-slate-900 font-black py-5 rounded-2xl transition-all shadow-xl dark:shadow-none flex items-center justify-center gap-3 active:scale-95 uppercase tracking-widest text-sm">
                    <Save size={20} className={isDark ? "" : "text-yellow-400"} /> Simpan Data
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden relative transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-slate-800 dark:bg-slate-700"></div>
            <div className="p-8 border-b border-slate-50 dark:border-slate-800/50 bg-slate-50/30 dark:bg-slate-800/20 flex flex-col sm:flex-row items-center justify-between gap-4 mt-2">
              <h2 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">📜 Log Produksi</h2>
              <div className="flex gap-3">
                {isAdmin && (
                  <label className="px-4 py-2.5 bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-800/50 text-blue-700 dark:text-blue-400 rounded-xl text-xs font-black flex items-center gap-2 cursor-pointer transition-all">
                    <UploadCloud size={16} /> Import CSV Migrasi
                    <input type="file" accept=".csv" className="hidden" onChange={handleCSVImport} />
                  </label>
                )}
                {isAdmin && totalJobsCount === 0 && (
                  <label
                    title="Satu kali saja — hanya tersedia saat tabel kosong"
                    className="px-4 py-2.5 bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-800/50 text-orange-700 dark:text-orange-400 rounded-xl text-xs font-black flex items-center gap-2 cursor-pointer transition-all"
                  >
                    <UploadCloud size={16} /> Import CSV Legacy (1x)
                    <input type="file" accept=".csv" className="hidden" onChange={handleLegacyCSVImport} />
                  </label>
                )}
                <button onClick={exportCSV} className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black flex items-center gap-2 transition-all shadow-md dark:shadow-none">
                  <Download size={16} /> Export CSV
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50/50 dark:bg-slate-800/50 text-slate-400 dark:text-slate-500 text-[10px] uppercase tracking-[0.2em] font-black border-b border-slate-100 dark:border-slate-800">
                    <th className="px-8 py-5">Info Job</th>
                    <th className="px-8 py-5">Klien & Deskripsi</th>
                    <th className="px-8 py-5 text-center">Volume</th>
                    <th className="px-8 py-5 text-right">Total IDR</th>
                    <th className="px-8 py-5 text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                  {jobsLoading ? (
                    <tr><td colSpan="5" className="p-16 text-center text-slate-400 dark:text-slate-500 text-sm italic font-medium tracking-widest">Menghubungkan ke server...</td></tr>
                  ) : jobs.length === 0 ? (
                    <tr><td colSpan="5" className="p-16 text-center text-slate-400 dark:text-slate-500 text-sm">Belum ada data produksi yang tersimpan.</td></tr>
                  ) : (
                    jobs.map((job) => (
                      <tr key={job.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors group">
                        <td className="px-8 py-6">
                          <p className="font-black text-slate-800 dark:text-slate-200 text-sm">{job.tanggal}</p>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-tight mt-0.5">Op: {job.operator}</p>
                        </td>
                        <td className="px-8 py-6">
                          <p className="text-[10px] text-blue-600 dark:text-blue-400 font-black uppercase mb-1 tracking-wider">{job.customer || 'Pelanggan Umum'}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 italic leading-relaxed">"{job.deskripsi}"</p>
                        </td>
                        <td className="px-8 py-6 text-center">
                          <div className="bg-slate-100 dark:bg-slate-800 inline-block px-3 py-1.5 rounded-lg">
                            <span className="text-xs font-black text-slate-700 dark:text-slate-300">{job.jumlah_unit} <span className="text-[9px] font-normal text-slate-400 dark:text-slate-500">Pcs</span></span>
                          </div>
                          <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1.5 font-bold uppercase tracking-tighter">@{job.durasi_menit}m/pcs</p>
                        </td>
                        <td className="px-8 py-6 text-right font-black text-sm text-slate-900 dark:text-slate-200">{(job.total_penghasilan || 0).toLocaleString()}</td>
                        <td className="px-8 py-6 text-center">
                          <div className="flex justify-center gap-3">
                            {isAdmin ? (
                              <>
                                <button onClick={() => setEditingJob(job)} className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-all hover:scale-110"><Edit3 size={18} /></button>
                                <button onClick={() => setJobToDelete(job.id)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-all hover:scale-110"><Trash2 size={18} /></button>
                              </>
                            ) : <Lock size={16} className="text-slate-200 dark:text-slate-700" title="Locked" />}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Modal Edit Data */}
      {editingJob && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-2xl w-full shadow-2xl my-8 relative transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-blue-500"></div>
            <div className="flex justify-between items-center mb-10 mt-2">
              <h3 className="text-2xl font-black text-slate-800 dark:text-white uppercase tracking-tighter">🛠️ Revisi Produksi</h3>
              <button onClick={() => setEditingJob(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all"><X size={24} /></button>
            </div>
            <form onSubmit={handleUpdateJob} className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-6">
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Tanggal</span><input type="date" value={editingJob.tanggal} onChange={(e) => setEditingJob({ ...editingJob, tanggal: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400 font-bold color-scheme-light dark:color-scheme-dark" /></label>
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Operator</span><input type="text" value={editingJob.operator} onChange={(e) => setEditingJob({ ...editingJob, operator: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400 font-bold" /></label>
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Invoice</span><input type="text" value={editingJob.invoice_code} onChange={(e) => setEditingJob({ ...editingJob, invoice_code: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400" /></label>
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Customer</span><input type="text" value={editingJob.customer} onChange={(e) => setEditingJob({ ...editingJob, customer: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400" /></label>
              </div>
              <div className="space-y-6">
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Deskripsi</span><input type="text" value={editingJob.deskripsi} onChange={(e) => setEditingJob({ ...editingJob, deskripsi: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400" /></label>
                <div className="grid grid-cols-2 gap-6">
                  <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Volume</span><input type="number" value={editingJob.jumlah_unit} onChange={(e) => setEditingJob({ ...editingJob, jumlah_unit: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400 font-bold" /></label>
                  <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Durasi (m)</span><input type="number" value={editingJob.durasi_menit} onChange={(e) => setEditingJob({ ...editingJob, durasi_menit: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400 font-bold" /></label>
                </div>
                <label className="block"><span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Harga/Unit</span><input type="number" value={editingJob.harga_per_unit} onChange={(e) => setEditingJob({ ...editingJob, harga_per_unit: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-blue-400 font-black text-slate-800 dark:text-slate-200" /></label>
                <div className="pt-6 flex gap-4">
                  <button type="button" onClick={() => setEditingJob(null)} className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold py-5 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all uppercase text-[10px] tracking-widest font-black">Batal</button>
                  <button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-black py-5 rounded-2xl shadow-xl shadow-blue-100 dark:shadow-none transition-all flex items-center justify-center gap-2 active:scale-95 uppercase text-[10px] tracking-widest"><Check size={18} /> Update</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Konfirmasi Hapus */}
      {jobToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-sm w-full shadow-2xl relative overflow-hidden transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-red-500"></div>
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-black text-slate-800 dark:text-white tracking-tighter">Hapus Data?</h3>
              <button onClick={() => setJobToDelete(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all"><X size={24} /></button>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-8 leading-relaxed">
              Apakah kamu yakin ingin menghapus data produksi ini secara permanen? Data tidak dapat dikembalikan.
            </p>
            <div className="flex gap-4">
              <button onClick={() => setJobToDelete(null)} className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold py-4 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all uppercase text-[10px] tracking-widest">Batal</button>
              <button onClick={confirmDelete} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-black py-4 rounded-2xl shadow-xl shadow-red-100 dark:shadow-none transition-all active:scale-95 uppercase text-[10px] tracking-widest flex items-center justify-center gap-2">
                <Trash2 size={16} /> Hapus
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Target Bulanan */}
      {showTargetEditor && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-md w-full shadow-2xl relative overflow-hidden transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-yellow-400 dark:bg-yellow-500"></div>
            <div className="flex justify-between items-center mb-2 mt-2">
              <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-tighter">🎯 Target Bulanan</h3>
              <button onClick={() => setShowTargetEditor(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all"><X size={22} /></button>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest mb-8">{formatYearMonth(period.year, period.month)}</p>
            <form onSubmit={handleSaveTarget} className="space-y-6">
              <div>
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Revenue Target (opsional)</label>
                <div className="relative">
                  <div className="absolute left-4 top-4.5 text-slate-400 dark:text-slate-500 font-bold text-sm">Rp</div>
                  <input
                    type="number" min="0" placeholder="Kosongkan jika tidak ada"
                    value={targetForm.revenueTarget}
                    onChange={(e) => setTargetForm((prev) => ({ ...prev, revenueTarget: e.target.value }))}
                    className="w-full pl-12 p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 font-black text-slate-800 dark:text-slate-100"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 block">Production Target (pcs, opsional)</label>
                <input
                  type="number" min="0" placeholder="Kosongkan jika tidak ada"
                  value={targetForm.unitTarget}
                  onChange={(e) => setTargetForm((prev) => ({ ...prev, unitTarget: e.target.value }))}
                  className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 font-black text-slate-800 dark:text-slate-100"
                />
              </div>
              {targetError && <p className="text-red-500 text-[10px] font-bold uppercase tracking-wider">{targetError}</p>}
              <div className="flex gap-4 pt-2">
                <button type="button" onClick={() => setShowTargetEditor(false)} className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold py-4 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all uppercase text-[10px] tracking-widest">Batal</button>
                <button type="submit" disabled={targetSaving} className="flex-1 bg-slate-900 dark:bg-yellow-500 text-white dark:text-slate-900 font-black py-4 rounded-2xl shadow-xl dark:shadow-none transition-all active:scale-95 uppercase text-[10px] tracking-widest disabled:opacity-60 flex items-center justify-center gap-2">
                  <Check size={16} /> {targetSaving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="max-w-6xl mx-auto mt-12 text-center text-slate-400 dark:text-slate-500 text-[9px] font-black uppercase tracking-[0.5em] opacity-50 pb-10 transition-colors">
        CG Digital Print Karawang • Supabase Production System v3.0
      </div>
    </div>
  );
};

export default App;
