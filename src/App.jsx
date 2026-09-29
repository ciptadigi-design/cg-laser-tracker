import React, { useState, useEffect } from 'react';
import {
  PlusCircle, History, Save, Trash2, Edit3, Download,
  Clock, User, Hash, Package, DollarSign, Lock, Unlock,
  X, Check, Bell, Sun, Moon, UploadCloud
} from 'lucide-react';

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, onSnapshot, addDoc, doc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';

// --- CSV MIGRATION TRANSPORT (export/import validation, lossless round trip) ---
import { exportJobsToCsv, parseImportCsv } from './lib/csvMigration';

/**
 * --- KONFIGURASI FIREBASE MILIKMU ---
 * Cek override bawaan sistem dihapus total agar selalu terkoneksi 
 * 100% ke database cg-laser-tracker milikmu.
 */
const firebaseConfig = {
  apiKey: "AIzaSyDmATeZFwmwSPBoOvZAm4-YAVXZQ2fb9A4",
  authDomain: "cg-laser-tracker.firebaseapp.com",
  projectId: "cg-laser-tracker",
  storageBucket: "cg-laser-tracker.firebasestorage.app",
  messagingSenderId: "298068953473",
  appId: "1:298068953473:web:f9e798be563c7030e34080",
  measurementId: "G-QT3CC4CCY3"
};

// Inisialisasi Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ADMIN_PASSWORD = "cg";

const App = () => {
  const [activeTab, setActiveTab] = useState('input');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  // State Admin & Notifikasi
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [loginError, setLoginError] = useState("");
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

  // Logika Harga
  useEffect(() => {
    const qty = parseInt(formData.jumlah_unit) || 0;
    let price = 50000;
    if (qty >= 10 && qty <= 50) price = 35000;
    else if (qty > 50) price = 25000;
    setFormData(prev => ({ ...prev, harga_per_unit: price }));
  }, [formData.jumlah_unit]);

  // --- FIREBASE: FETCH DATA REAL-TIME ---
  useEffect(() => {
    setLoading(true);

    // Langsung akses koleksi laser_jobs tanpa proteksi tambahan
    const unsubscribe = onSnapshot(collection(db, 'laser_jobs'), (snapshot) => {
      const data = snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
      // Sortir data terbaru di atas
      data.sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
      setJobs(data);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching data: ", error);
      setLoading(false);
      notify("Gagal mengambil data: " + error.message, 'error');
    });

    return () => unsubscribe();
  }, []);

  const handleAdminLogin = (e) => {
    e.preventDefault();
    if (passInput === ADMIN_PASSWORD) {
      setIsAdmin(true);
      setShowLoginModal(false);
      setPassInput("");
      setLoginError("");
      notify("Berhasil masuk sebagai Admin", "success");
    } else {
      setLoginError("Password salah!");
    }
  };

  // --- FIREBASE: SIMPAN DATA BARU ---
  const handleSubmit = async (e) => {
    e.preventDefault();

    const total = formData.jumlah_unit * formData.harga_per_unit;
    const payload = { ...formData, total_penghasilan: total, created_at: new Date().toISOString() };

    try {
      await addDoc(collection(db, 'laser_jobs'), payload);
      notify('Job berhasil disimpan ke Cloud!', 'success');
      setFormData({ ...formData, invoice_code: '', customer: '', deskripsi: '', jumlah_unit: 1 });
    } catch (err) {
      notify('Gagal simpan: ' + err.message, 'error');
    }
  };

  // --- FIREBASE: UPDATE DATA ---
  const handleUpdateJob = async (e) => {
    e.preventDefault();
    if (!editingJob || !isAdmin) return;

    const total = editingJob.jumlah_unit * editingJob.harga_per_unit;
    const payload = { ...editingJob, total_penghasilan: total };
    const jobId = payload.id;
    delete payload.id;

    try {
      await updateDoc(doc(db, 'laser_jobs', jobId), payload);
      notify('Data berhasil diperbarui!', 'success');
      setEditingJob(null);
    } catch (err) {
      notify('Gagal update: ' + err.message, 'error');
    }
  };

  // --- FIREBASE: HAPUS DATA ---
  const confirmDelete = async () => {
    if (!isAdmin || !jobToDelete) return;
    try {
      await deleteDoc(doc(db, 'laser_jobs', jobToDelete));
      notify('Data dihapus', 'success');
      setJobToDelete(null);
    } catch (err) {
      notify('Gagal hapus: ' + err.message, 'error');
    }
  };

  // --- FITUR MIGRASI: IMPORT CSV KE FIREBASE ---
  // Pre-flight pipeline (parse -> validate headers -> validate every row -> check
  // duplicates) happens entirely in parseImportCsv before any Firestore write.
  // If any row is invalid or any duplicate legacy_firebase_id is detected, ZERO
  // records are written.
  const handleCSVImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target.result;
      const result = parseImportCsv(text, jobs);

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
        // Firestore batched writes are capped at 500 ops; chunk to stay safely
        // under that while keeping each chunk atomic (all-or-nothing).
        const CHUNK_SIZE = 450;
        for (let i = 0; i < result.rows.length; i += CHUNK_SIZE) {
          const chunk = result.rows.slice(i, i + CHUNK_SIZE);
          const batch = writeBatch(db);
          chunk.forEach((row) => {
            const ref = doc(collection(db, 'laser_jobs'));
            batch.set(ref, row);
          });
          await batch.commit();
        }
        notify(`Imported: ${result.rows.length} records | Rejected: 0`, 'success');
      } catch (err) {
        console.error('Gagal menulis migrasi ke Firestore', err);
        notify(`Gagal migrasi: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // Canonical, lossless CSV transport: includes legacy_firebase_id + created_at
  // and uses RFC 4180 quoting (via csvMigration.exportJobsToCsv) so commas,
  // quotes and newlines inside customer/deskripsi survive the round trip.
  const exportCSV = () => {
    const csvContent = exportJobsToCsv(jobs);
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
  };

  const stats = {
    income: jobs.reduce((acc, curr) => acc + (curr.total_penghasilan || 0), 0),
    units: jobs.reduce((acc, curr) => acc + (parseInt(curr.jumlah_unit) || 0), 0),
    duration: jobs.reduce((acc, curr) => acc + ((parseInt(curr.jumlah_unit) || 0) * (parseInt(curr.durasi_menit) || 0)), 0)
  };

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

          <button
            onClick={() => isAdmin ? setIsAdmin(false) : setShowLoginModal(true)}
            className={`p-3 rounded-2xl flex items-center gap-2 font-bold transition-all shadow-sm border ${isAdmin ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/50' : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
          >
            {isAdmin ? <Unlock size={20} /> : <Lock size={20} />}
            <span className="text-xs uppercase tracking-tighter font-black hidden sm:block">{isAdmin ? "Admin Active" : "Locked"}</span>
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white dark:bg-slate-900 p-7 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 flex items-center gap-5 hover:shadow-md transition-all">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/30 rounded-2xl text-emerald-600 dark:text-emerald-400"><DollarSign size={28} /></div>
            <div>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Total Pemasukan</p>
              <p className="text-2xl font-black text-slate-800 dark:text-white">Rp {stats.income.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 p-7 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 flex items-center gap-5 hover:shadow-md transition-all">
            <div className="p-4 bg-blue-50 dark:bg-blue-900/30 rounded-2xl text-blue-600 dark:text-blue-400"><Package size={28} /></div>
            <div>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Unit Terproduksi</p>
              <p className="text-2xl font-black text-slate-800 dark:text-white">{stats.units.toLocaleString()} <span className="text-sm font-normal text-slate-400">Pcs</span></p>
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
                    <input type="number" min="1" value={formData.jumlah_unit} onChange={e => setFormData({ ...formData, jumlah_unit: e.target.value })} className="w-full p-4 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all font-bold text-slate-900 dark:text-slate-100" />
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
                  {loading ? (
                    <tr><td colSpan="5" className="p-16 text-center text-slate-400 dark:text-slate-500 text-sm italic font-medium tracking-widest">Menghubungkan ke server Firebase...</td></tr>
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

      {/* Modal Admin Password */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-sm w-full shadow-2xl relative overflow-hidden transition-colors">
            <div className="absolute top-0 left-0 w-full h-2 bg-yellow-400 dark:bg-yellow-500"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-black text-slate-800 dark:text-white tracking-tighter">Admin Akses</h3>
              <button onClick={() => { setShowLoginModal(false); setLoginError(""); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all"><X size={24} /></button>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-8 font-medium leading-relaxed uppercase tracking-widest text-center">Password Khusus Owner</p>
            <form onSubmit={handleAdminLogin}>
              <input type="password" autoFocus value={passInput} onChange={(e) => { setPassInput(e.target.value); setLoginError(""); }} placeholder="******" className="w-full p-5 bg-slate-50 dark:bg-slate-950 rounded-2xl border-none outline-none focus:ring-2 focus:ring-yellow-400 transition-all mb-4 text-center font-black text-lg tracking-widest text-slate-800 dark:text-white" />
              {loginError && <p className="text-red-500 text-[10px] font-bold text-center mb-4 uppercase tracking-wider">{loginError}</p>}
              <button type="submit" className="w-full bg-slate-900 dark:bg-yellow-500 text-white dark:text-slate-900 font-black py-5 rounded-2xl shadow-xl dark:shadow-none transition-all active:scale-95 uppercase tracking-widest text-sm">Unlock System</button>
            </form>
          </div>
        </div>
      )}

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

      {/* Footer */}
      <div className="max-w-6xl mx-auto mt-12 text-center text-slate-400 dark:text-slate-500 text-[9px] font-black uppercase tracking-[0.5em] opacity-50 pb-10 transition-colors">
        CG Digital Print Karawang • Firebase Production System v2.0
      </div>
    </div>
  );
};

export default App;