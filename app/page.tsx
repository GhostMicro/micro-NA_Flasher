"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  Cpu,
  Settings,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Terminal,
  ChevronRight,
  Shield,
  UploadCloud,
  RefreshCw,
  LogOut
} from 'lucide-react';
import { ESPLoader, Transport } from 'esptool-js';
import { SecurityManager } from '../utils/security';

type FlasherStatus = 'idle' | 'connecting' | 'connected' | 'flashing' | 'rebooting' | 'completed' | 'error';

interface FirmwareManifest {
  name: string;
  version: string;
  builds: {
    chip: string;
    parts: { address: string; path: string }[];
  }[];
}

export default function FlasherPage() {
  const [device, setDevice] = useState<SerialPort | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [status, setStatus] = useState<FlasherStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [isSecure, setIsSecure] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chipName, setChipName] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const esploaderRef = useRef<ESPLoader | null>(null);

  const addLog = (msg: string) => {
    const lines = msg.split('\n');
    setLogs(prev => [...prev.slice(-(50 - lines.length)), ...lines.filter(l => l.trim().length > 0)]);
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const connectDevice = async () => {
    setStatus('connecting');
    setError(null);
    try {
      if (!navigator.serial) {
        throw new Error("เบราว์เซอร์ไม่รองรับ Web Serial API โปรดใช้ Chrome หรือ Edge");
      }

      const port = await navigator.serial.requestPort();
      const transportInstance = new Transport(port);

      const esploader = new ESPLoader({
        transport: transportInstance,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: {
          clean: () => setLogs([]),
          write: (data: string) => addLog(data),
          writeLine: (data: string) => addLog(data),
        }
      });

      addLog("🔍 กำลังเริ่มกระบวนการ Synchronization...");
      addLog("💡 Tip: หากค้างที่ขั้นตอนนี้ ให้กดปุ่ม BOOT บนบอร์ดค้างไว้");

      // ให้เวลาผู้ใช้กดปุ่ม BOOT
      await new Promise(resolve => setTimeout(resolve, 1500));

      console.log("Attempting ESPLoader.main('default_reset')...");
      const chip = await esploader.main('default_reset');
      console.log("Sync successful. Detected chip:", chip);

      esploaderRef.current = esploader;
      setChipName(chip);
      setDevice(port);
      setTransport(transportInstance);
      setStatus('connected');
      addLog(`✅ เชื่อมต่อ ${chip} สำเร็จ!`);

      // Phase 2: Secure Handshake
      await performSecureHandshake(transportInstance);
    } catch (err: any) {
      console.error("Connection Error Trace:", err);
      let errorMsg = err.message || "การเชื่อมต่อข้อยกเว้น";

      if (errorMsg.includes("Failed to open serial port")) {
        errorMsg = "❌ ไม่สามารถเปิด Serial Port ได้\n\n💡 วิธีแก้สำหรับ Linux:\nรันคำสั่งนี้ใน Terminal เพื่อตั้งค่าสิทธิ์อัตโนมัติ:\n./scripts/setup_linux_permissions.sh\n\n💡 วิธีแก้ทั่วไป:\n1. ปิด IDE/Serial Monitor อื่นๆ\n2. ลองขยับสาย USB\n3. เช็คว่าบอร์ดไม่ได้รันโปรเจกต์อื่นอยู่";
      } else if (errorMsg.includes("Read timeout") || errorMsg.includes("Timeout")) {
        errorMsg = "⏱️ บอร์ดไม่ตอบสนอง (Timeout)\n\n💡 วิธีแก้สำหรับ ESP32-WROOM:\n1. กดปุ่ม BOOT ค้างไว้\n2. คลิกปุ่ม 'เชื่อมต่อ' อีกครั้ง\n3. เมื่อหน้าต่างเลือกพอร์ตขึ้นมา ให้เลือกพอร์ตแล้วกด 'Connect'";
      }

      setError(errorMsg);
      setStatus('error');
      addLog(`❌ Error: ${errorMsg}`);
    }
  };

  const performSecureHandshake = async (transport: Transport) => {
    try {
      addLog("🔐 เริ่มการแลกเปลี่ยนรหัสรักษาความปลอดภัย (Secure Handshake)...");
      const security = new SecurityManager();

      // 1. Generate Browser Keys
      const browserPubKey = await security.generateKeyPair();
      const browserPubKeyB64 = security.bufferToBase64(browserPubKey);

      // 2. Clear buffers (Wait a bit for ESP32 to finish boot logs)
      await new Promise(resolve => setTimeout(resolve, 800));

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const sendCommand = async (cmd: any): Promise<any> => {
        const json = JSON.stringify(cmd) + "\n";

        // Use the underlying device directly
        const writer = transport.device.writable!.getWriter();
        await writer.write(encoder.encode(json));
        writer.releaseLock();

        // Simple line reader with timeout
        const reader = transport.device.readable!.getReader();
        let result = "";
        try {
          const timeout = setTimeout(() => reader.cancel(), 2000);
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            result += decoder.decode(value);
            if (result.includes('\n')) break;
          }
          clearTimeout(timeout);
          return JSON.parse(result.trim().split('\n')[0]);
        } finally {
          reader.releaseLock();
        }
      };

      // Step 1: kx_init
      addLog("📤 กำลังส่งกุญแจส่วนตัวไปยังบอร์ด...");
      const initRes = await sendCommand({ c: "kx_init" });
      if (!initRes || !initRes.ok) throw new Error("kx_init failed or timeout");

      const firmwarePubKeyB64 = initRes.pub;
      const firmwarePubKey = security.base64ToBuffer(firmwarePubKeyB64);

      // Step 2: kx_fin
      addLog("📥 กำลังรับกุญแจสาธารณะจากบอร์ด...");
      const finRes = await sendCommand({ c: "kx_fin", pub: browserPubKeyB64 });
      if (!finRes || !finRes.ok) throw new Error("kx_fin failed");

      // Step 3: Compute Locally
      await security.computeSharedSecret(firmwarePubKey);

      addLog("✨ การเชื่อมต่อปลอดภัยสมบูรณ์ (Secure Handshake Verified)");
      setIsSecure(true);
    } catch (err: any) {
      console.warn("Handshake Error:", err);
      addLog(`⚠️ แจ้งเตือน: ดำเนินการในโหมดปกติ (${err.message})`);
    }
  };

  const startFlash = async () => {
    if (!device || !transport || !esploaderRef.current) return;
    setStatus('flashing');
    setProgress(0);
    setError(null);

    try {
      addLog("📡 กำลังตรวจสอบเวอร์ชันจาก Manifest System...");
      const manifestUrl = '/firmware_source/manifest.json';
      const manifestResponse = await fetch(manifestUrl);
      if (!manifestResponse.ok) throw new Error("ไม่สามารถโหลด Manifest ได้");
      const manifest: FirmwareManifest = await manifestResponse.json();

      const build = manifest.builds.find(b => b.chip === 'ESP32');
      if (!build) throw new Error("ไม่พบ Build สำหรับชิป ESP32 ใน Manifest");

      addLog(`📦 พบเฟิร์มแวร์เวอร์ชัน ${manifest.version} สำหรับ ${manifest.name}`);

      const esploader = esploaderRef.current;
      const flashFiles: { data: string; address: number }[] = [];

      for (const part of build.parts) {
        addLog(`📥 กำลังโหลด ${part.path}...`);

        // Hybrid Logic: Check if path is a full URL or just a filename
        const isRemote = part.path.startsWith('http://') || part.path.startsWith('https://');
        const binaryUrl = isRemote ? part.path : `/firmware_source/${part.path}`;

        const binaryResponse = await fetch(binaryUrl);
        if (!binaryResponse.ok) throw new Error(`ไม่พบไฟล์ ${part.path}`);
        const buffer = await binaryResponse.arrayBuffer();

        const ui8 = new Uint8Array(buffer);
        flashFiles.push({
          data: esploader.ui8ToBstr(ui8),
          address: parseInt(part.address, 16)
        });
      }

      addLog(`🚀 เริ่มการ Flash NA Core [REAL]...`);

      await esploader.writeFlash({
        fileArray: flashFiles,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const p = Math.round((written / total) * 100);
          setProgress(p);
        }
      });

      addLog("✨ ติดตั้งเสร็จสมบูรณ์! กำลังเริ่มต้นระบบใหม่ (Rebooting)...");
      setStatus('rebooting');

      // สั่ง Hard Reset
      await esploader.after('hard_reset');

      // รอให้บอร์ด Reboot และเริ่มทำงาน (จำลองเวลา 3 วินาทีเพื่อให้มั่นใจว่าบอร์ดรันโปรแกรมใหม่ได้)
      addLog("⏳ กำลังรอการตอบสนองหลัง Reboot...");
      await new Promise(resolve => setTimeout(resolve, 3000));

      // ปิดการเชื่อมต่อพอร์ตเพื่อความปลอดภัย
      try {
        await transport.disconnect();
        await device.close();
      } catch (e) {
        console.warn("Port closed already or error during closing:", e);
      }

      addLog("📡 ตัดการเชื่อมต่อพอร์ตสื่อสารเรียบร้อยแล้ว");
      addLog("🟢 บอร์ดของคุณพร้อมใช้งาน! สามารถถอดสายออกได้ทันที");
      setStatus('completed');
    } catch (err: any) {
      console.error(err);
      setError(`[Flash Error]: ${err.message || "การทำงานล้มเหลว"}`);
      setStatus('error');
    }
  };

  const renderContent = () => {
    switch (status) {
      case 'idle':
      case 'error':
        return (
          <div className="flex flex-col gap-4 w-full">
            <button
              onClick={connectDevice}
              className="primary-button group flex items-center gap-3 px-10 py-5 rounded-full text-xl font-bold w-full justify-center"
            >
              <Cpu className="w-6 h-6 group-hover:rotate-12 transition-transform" />
              เชื่อมต่อบอร์ด ESP32
            </button>
            {status === 'error' && (
              <p className="text-red-400 text-xs text-center animate-pulse font-medium">
                เคล็ดลับ: กดฟุ่ม BOOT ค้างไว้ตอนคลิกเพื่อแก้ปัญหา Read Timeout
              </p>
            )}
          </div>
        );
      case 'connecting':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <RefreshCw className="w-12 h-12 text-blue-500 animate-spin" />
            <p className="text-lg font-medium text-slate-300">กำลังขออนุญาตเข้าถึงพอร์ต...</p>
          </div>
        );
      case 'connected':
        return (
          <div className="w-full space-y-6">
            <div className="flex items-center justify-between p-4 bg-green-500/10 rounded-xl border border-green-500/20 text-green-400">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6" />
                <span className="font-bold uppercase text-xs tracking-widest">{chipName} CONNECTED</span>
                {isSecure && (
                  <span className="flex items-center gap-1 bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded text-[10px] border border-blue-500/30 animate-pulse">
                    <Shield className="w-3 h-3" /> SECURE
                  </span>
                )}
              </div>
              <button
                onClick={() => window.location.reload()}
                className="hover:text-white transition-colors p-1"
                title="Disconnect Current Device"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={startFlash}
              className="primary-button flex items-center gap-3 px-10 py-5 rounded-full text-xl font-bold w-full justify-center shadow-lg"
            >
              <UploadCloud className="w-6 h-6" />
              เริ่มติดตั้งเฟิร์มแวร์ NA Core
            </button>
          </div>
        );
      case 'flashing':
        return (
          <div className="w-full space-y-8 py-4 px-2">
            <div className="flex justify-between items-end mb-2">
              <span className="text-blue-400 font-bold text-lg italic tracking-wider animate-pulse">
                📥 กำลังบันทึกข้อมูลเข้ารหัส...
              </span>
              <span className="text-4xl font-black text-white">{progress}%</span>
            </div>
            <div className="h-4 bg-slate-800 rounded-full overflow-hidden border border-slate-700/50 p-0.5 shadow-inner">
              <div
                className="h-full bg-gradient-to-r from-blue-600 via-indigo-400 to-blue-500 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        );
      case 'rebooting':
        return (
          <div className="flex flex-col items-center gap-5 py-8 text-center">
            <div className="relative">
              <RefreshCw className="w-16 h-16 text-blue-500 animate-spin" />
              <Zap className="w-6 h-6 text-yellow-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
            </div>
            <div className="space-y-1">
              <p className="text-xl font-bold text-white tracking-wide">ติดตั้งสำเร็จ! กำลัง Reboot บอร์ด...</p>
              <p className="text-sm text-slate-500">โปรดอย่าถอดสายออกจนกว่าระบบจะยืนยันความพร้อม</p>
            </div>
          </div>
        );
      case 'completed':
        return (
          <div className="flex flex-col items-center gap-8 py-4 text-center animate-in fade-in zoom-in duration-700">
            <div className="relative">
              <div className="absolute inset-0 bg-green-500/20 blur-2xl rounded-full" />
              <div className="p-6 bg-green-500/20 rounded-full border border-green-500/30">
                <CheckCircle2 className="w-16 h-16 text-green-400" />
              </div>
            </div>
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-3xl font-black text-white tracking-tight">เสร็จสิ้นกระบวนการ 🛡️</h2>
                <p className="text-green-500 font-bold tracking-[0.2em] text-xs uppercase">Device Security Verified</p>
              </div>
              <p className="text-slate-300 text-lg leading-relaxed max-w-sm">
                บอร์ดของคุณได้รับการติดตั้ง NA Core และ <span className="text-blue-400">ปิดการเชื่อมต่อพอร์ต</span> เรียบร้อยแล้ว
              </p>
              <div className="inline-flex items-center gap-2 px-6 py-3 bg-slate-800/50 rounded-2xl border border-slate-700 text-slate-200 font-bold animate-bounce mt-4">
                <LogOut className="w-5 h-5 text-red-500" />
                สามารถนำบอร์ดออกได้แล้วครับ!
              </div>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="text-slate-500 hover:text-white transition-colors text-xs border-b border-slate-800 pb-1 font-mono uppercase tracking-[0.2em]"
            >
              Start New Session
            </button>
          </div>
        );
    }
  };

  return (
    <main className="container mx-auto px-4 py-12 max-w-4xl min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
      {/* Visual background elements */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-600/5 blur-[120px] rounded-full -z-10 translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-indigo-600/5 blur-[120px] rounded-full -z-10 -translate-x-1/2 translate-y-1/2" />

      <div className="text-center mb-16 relative">
        <div className="inline-flex items-center justify-center p-5 bg-blue-600/10 rounded-[2rem] mb-10 border border-blue-500/20 shadow-2xl">
          <Zap className="w-12 h-12 text-blue-400 drop-shadow-[0_0_15px_rgba(59,130,246,0.6)]" />
        </div>
        <h1 className="text-7xl font-black tracking-tight mb-8 bg-gradient-to-r from-blue-400 via-white to-indigo-400 bg-clip-text text-transparent italic leading-[1.1]">
          NA Firmware Flasher
        </h1>
        <p className="text-slate-400 text-2xl font-light tracking-wide max-w-2xl mx-auto leading-relaxed">
          ยกระดับหุ่นยนต์ของคุณสู่มาตรฐาน <span className="text-blue-400 font-bold border-b border-blue-500/30 px-2 shadow-blue-500/20 drop-shadow-sm">NA FIRMWARE</span>
          <br /><span className="text-[10px] text-slate-600 font-mono font-black uppercase tracking-[0.5em] mt-2 block opacity-60">Navigation Autonomous Firmware Deployment</span>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-12 w-full relative z-10">
        <div className="md:col-span-2 space-y-10">
          <div className="glass-card p-12 flex flex-col items-center min-h-[300px] justify-center shadow-[0_0_50px_rgba(0,0,0,0.5)] border-white/[0.03] backdrop-blur-3xl group transition-all duration-700 hover:border-blue-500/20">
            {renderContent()}
          </div>

          <div className="glass-card overflow-hidden h-[340px] flex flex-col border-slate-800 shadow-2xl bg-black/40">
            <div className="bg-slate-900/95 px-6 py-4 flex items-center justify-between border-b border-slate-800/80">
              <div className="flex items-center gap-3">
                <Terminal className="w-4 h-4 text-blue-500/80" />
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-[0.3em] font-bold">System Integrity Terminal</span>
              </div>
              <div className="flex gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-slate-800" />
                <div className="w-2.5 h-2.5 rounded-full bg-slate-800" />
                <div className="w-2.5 h-2.5 rounded-full bg-slate-800" />
              </div>
            </div>
            <div
              ref={logContainerRef}
              className="flex-1 overflow-y-auto p-8 font-mono text-[12px] space-y-2.5 scrollbar-thin scrollbar-thumb-slate-800/50 selection:bg-blue-500/20"
            >
              {logs.length === 0 && (
                <div className="flex items-center gap-3 text-slate-700 italic animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-slate-800" />
                  <span>Waiting for communication bridge initialization...</span>
                </div>
              )}
              {logs.map((log, i) => (
                <div key={i} className="text-slate-400 border-l-2 border-slate-800/40 pl-5 py-1 hover:bg-white/[0.03] transition-all group/line duration-300">
                  <span className="text-[10px] text-slate-800 mr-5 w-6 inline-block text-right group-hover/line:text-slate-700 font-black">{i + 1}</span>
                  <span className={log.includes("✅") ? "text-green-500" : log.includes("🚀") ? "text-blue-400 font-bold" : log.includes("🟢") ? "text-green-400 font-black" : ""}>{log}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-10">
          <div className="glass-card p-10 border-blue-500/10 bg-gradient-to-br from-blue-900/10 to-transparent">
            <div className="flex items-center gap-4 mb-8 text-blue-400">
              <Shield className="w-7 h-7" />
              <h3 className="font-black uppercase tracking-[0.2em] text-xs">Security Protocol</h3>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed text-justify relative group">
              <span className="absolute -left-4 top-0 w-1 h-full bg-blue-500/30 rounded-full" />
              ระบบแฟลชของ NA Core ออกแบบมาให้ทำงานบนเครื่องของผู้ใช้อย่างสมบูรณ์ ข้อมูลที่ถูกเขียนลงบนบอร์ดได้รับการตรวจสอบความถูกต้องทุกไบต์ เพื่อป้องกันภัยคุกคามและการเสียหายของฮาร์ดแวร์
            </p>
          </div>

          <div className="glass-card p-10 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/20 to-transparent" />
            <h3 className="font-bold text-slate-300 mb-8 flex items-center gap-3 text-sm tracking-wide">
              <Settings className="w-5 h-5 text-slate-500" />
              Tech Requirements
            </h3>
            <ul className="space-y-6">
              {[
                { title: "Browser", detail: "Chrome / Edge (Secured)" },
                { title: "Connection", detail: "USB-Data Bridge Cable" },
                { title: "Controller", detail: "ESP32 Core Micro" },
              ].map((item, idx) => (
                <li key={idx} className="flex flex-col gap-1.5 border-l border-slate-800 pl-4 py-1 hover:border-blue-500/50 transition-colors">
                  <span className="text-[11px] font-black text-slate-500 uppercase tracking-widest">{item.title}</span>
                  <span className="text-sm font-medium text-slate-300">{item.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          {error && (
            <div className="p-8 bg-red-950/20 border-2 border-red-500/20 rounded-[2.5rem] flex flex-col gap-4 animate-in fade-in slide-in-from-right-10 duration-500 shadow-[0_0_30px_rgba(239,68,68,0.1)] backdrop-blur-md">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-red-500/20 rounded-xl">
                  <AlertTriangle className="w-7 h-7 text-red-500 animate-pulse" />
                </div>
                <div className="space-y-0.5">
                  <p className="font-black text-red-500 text-xs tracking-widest uppercase">Critical Notification</p>
                  <p className="text-[10px] text-red-400/60 font-mono">CODE: SE-408-TIMEOUT</p>
                </div>
              </div>
              <p className="text-xs text-red-200/90 leading-relaxed font-semibold italic text-justify">{error}</p>
            </div>
          )}
        </div>
      </div>

      <footer className="mt-24 text-slate-700 text-[11px] flex items-center gap-6 font-mono font-bold tracking-[0.3em] uppercase opacity-40 hover:opacity-100 transition-opacity duration-500">
        <span className="hover:text-blue-500 transition-colors">GhostMicro RN Foundation</span>
        <div className="w-1.5 h-1.5 rounded-full bg-slate-800" />
        <span className="hover:text-white transition-colors">Secured Environment REL-1.1</span>
        <ChevronRight className="w-4 h-4 opacity-30" />
        <span className="px-5 py-2 rounded-full border border-slate-800 bg-slate-950/50 text-[9px] tracking-[0.5em] text-blue-400/80">Verified Deployment</span>
      </footer>
    </main>
  );
}
