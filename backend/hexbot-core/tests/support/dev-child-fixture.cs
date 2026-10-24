// Native test executable only. Each socket is an event/acknowledgement barrier.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
public class DevChildFixture {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AllocConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    static IntPtr input;
    delegate bool Handler(uint kind);
    static Handler handler = kind => true;
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler h, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
        string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr environment, string cwd, ref Startup startup, out Information process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref uint info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint size; public string reserved, desktop, title; public uint x,y,width,height,charsX,charsY,fill,flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct Information { public IntPtr process, thread; public uint pid, tid; }
    static string Q(string text) {
        var b = new StringBuilder("\""); int slashes=0;
        foreach(char c in text) {
            if(c=='\\') {slashes++; continue;}
            if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes);
            slashes=0; b.Append(c);
        }
        return b.Append('\\',slashes*2).Append('"').ToString();
    }
    static void Check(bool result) { if(!result) throw new System.ComponentModel.Win32Exception(); }
    static Information Launch(string exe, string arguments, bool group) {
        var si=new Startup(); si.size=(uint)Marshal.SizeOf(si);
        si.flags=0x100; si.input=input; si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
        Information pi;
        Check(CreateProcess(exe,new StringBuilder(Q(exe)+" "+arguments),IntPtr.Zero,IntPtr.Zero,true,
            group ? 0x204u : 4u,IntPtr.Zero,null,ref si,out pi));
        return pi;
    }
    public static int Main(string[] args) {
        input=GetStdHandle(-10);
        string mode=args[0]; int port=int.Parse(args[1]);
        using(var socket=new TcpClient("127.0.0.1",port))
        using(var stream=socket.GetStream())
        using(var writer=new StreamWriter(stream,new UTF8Encoding(false),1024,true) {AutoFlush=true}) {
            if(mode=="parent" || mode=="break" || mode=="ctrlc" || mode=="assignment") {
                IntPtr job=IntPtr.Zero;
                if(mode=="assignment") {
                    job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
                    uint restrictions=0xff; Check(SetInformationJobObject(job,4,ref restrictions,4));
                    Check(AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle));
                }
                bool console=mode=="break" || mode=="ctrlc";
                if(console) {Check(AllocConsole()); Check(SetConsoleCtrlHandler(handler,true));}
                string command="__dev-child test -- "+Q(args[2])+" tree "+port+" "+Q(args[2]);
                var launched=Launch(args[3],command,mode=="break"); int host=(int)launched.pid;
                var process=Process.GetProcessById(host);
                writer.WriteLine("{\"role\":\"parent\",\"pid\":"+Process.GetCurrentProcess().Id+",\"host\":"+host+"}");
                if(stream.ReadByte()!=1) return 93;
                Check(ResumeThread(launched.thread)==1); CloseHandle(launched.thread); CloseHandle(launched.process);
                if(console) {if(stream.ReadByte()!=1) return 91; Check(GenerateConsoleCtrlEvent(mode=="break" ? 1u : 0u,mode=="break" ? (uint)host : 0u));}
                using(process) {process.WaitForExit(); writer.WriteLine("{\"role\":\"done\",\"code\":"+process.ExitCode+"}"); return process.ExitCode;}
            }
            Process leaf=null;
            if(mode=="tree" || mode=="root-exit") {
                leaf=Process.Start(new ProcessStartInfo(args[2],"leaf "+port) {UseShellExecute=false});
                Console.CancelKeyPress+=(sender, e)=> { e.Cancel=true; lock(writer) writer.WriteLine("{\"role\":\"console-event\"}"); };
            }
            writer.WriteLine("{\"role\":\""+mode+"\",\"pid\":"+Process.GetCurrentProcess().Id+",\"leaf\":"+(leaf==null ? 0 : leaf.Id)+"}");
            if(stream.ReadByte()!=1) return 92;
            if(mode=="root-exit") return 17;
            // Only test barriers/lifetime signals can release a fixture.
            stream.ReadByte();
            return 0;
        }
    }
}
