import * as fs from 'fs';
import * as path from 'path';
import { diagnosticErrorKind } from './main/diagnostics';

export class Logger {
  private logFilePath: string | null = null;
  private logStream: fs.WriteStream | null = null;
  private enabled = false;

  initialize(logFolderPath: string, enabled: boolean) {
    this.cleanup();
    this.enabled = enabled;

    if (!enabled || !logFolderPath) {
      this.cleanup();
      return;
    }

    try {
      // 确保文件夹存在
      if (!fs.existsSync(logFolderPath)) {
        fs.mkdirSync(logFolderPath, { recursive: true });
      }

      // 创建日志文件名: log_YYYY-MM-DD_HH-mm-ss.txt
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.logFilePath = path.join(logFolderPath, `log_${timestamp}.txt`);

      // 创建写入流
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      const stream = this.logStream;
      stream.on('error', (error) => {
        console.error('Failed to write log:', diagnosticErrorKind(error));
        if (this.logStream === stream) {
          this.logStream = null; this.logFilePath = null; this.enabled = false;
        }
        stream.destroy();
      });

      this.log('=== Application Started ===');
      this.log(`Timestamp: ${new Date().toISOString()}`);
      this.log(`Platform: ${process.platform}`);
      this.log(`Node Version: ${process.version}`);
      this.log('');
    } catch (error) {
      console.error('Failed to initialize logger:', diagnosticErrorKind(error));
      this.cleanup();
    }
  }

  log(message: string, level: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG' = 'INFO') {
    if (!this.enabled || !this.logStream) return;

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    try {
      this.logStream.write(logLine);
    } catch (error) {
      console.error('Failed to write log:', diagnosticErrorKind(error));
    }
  }

  cleanup() {
    if (this.logStream) {
      this.log('=== Application Closed ===');
      this.logStream.end();
      this.logStream = null;
    }
    this.logFilePath = null;
    this.enabled = false;
  }
}

export const logger = new Logger();
