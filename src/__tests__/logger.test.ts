import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../logger';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// Mock fs 模块
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
}));

describe('Logger', () => {
  let logger: Logger;
  let mockWriteStream: any;

  beforeEach(() => {
    logger = new Logger();

    // 创建 mock write stream
    mockWriteStream = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    });

    // Mock fs 函数
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.createWriteStream).mockReturnValue(mockWriteStream as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('应该在启用时初始化日志文件', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, true);

    expect(fs.createWriteStream).toHaveBeenCalled();
    expect(mockWriteStream.write).toHaveBeenCalled();
  });

  it('应该在禁用时不创建日志文件', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, false);

    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  it('应该在启用时写入日志消息', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, true);

    // 清除初始化时的调用
    vi.clearAllMocks();

    logger.log('Test message', 'INFO');

    expect(mockWriteStream.write).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] Test message')
    );
  });

  it('应该在禁用时不写入日志消息', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, false);

    logger.log('Test message', 'INFO');

    expect(mockWriteStream.write).not.toHaveBeenCalled();
  });

  it('应该支持不同的日志级别', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, true);

    // 清除初始化时的调用
    vi.clearAllMocks();

    logger.log('Info message', 'INFO');
    logger.log('Error message', 'ERROR');
    logger.log('Warning message', 'WARN');
    logger.log('Debug message', 'DEBUG');

    expect(mockWriteStream.write).toHaveBeenCalledTimes(4);
    expect(mockWriteStream.write).toHaveBeenCalledWith(
      expect.stringContaining('[INFO]')
    );
    expect(mockWriteStream.write).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR]')
    );
    expect(mockWriteStream.write).toHaveBeenCalledWith(
      expect.stringContaining('[WARN]')
    );
    expect(mockWriteStream.write).toHaveBeenCalledWith(
      expect.stringContaining('[DEBUG]')
    );
  });

  it('应该在清理时关闭日志流', () => {
    const logFolder = '/test/logs';
    logger.initialize(logFolder, true);

    logger.cleanup();

    expect(mockWriteStream.end).toHaveBeenCalled();
  });

  it('closes the previous stream before opening its replacement', () => {
    logger.initialize('/logs/old', true);
    const replacement = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(replacement as unknown as fs.WriteStream);
    logger.initialize('/logs/new', true);
    expect(mockWriteStream.end).toHaveBeenCalledOnce();
    logger.log('AFTER');
    expect(replacement.write).toHaveBeenCalledWith(expect.stringContaining('AFTER'));
    expect(mockWriteStream.write).not.toHaveBeenCalledWith(expect.stringContaining('AFTER'));
    logger.cleanup(); expect(replacement.end).toHaveBeenCalledOnce();
  });

  it('handles asynchronous log errors without throwing or affecting a replacement', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.initialize('/logs/old', true);
    const replacement = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(replacement as unknown as fs.WriteStream);
    logger.initialize('/logs/new', true);
    expect(() => mockWriteStream.emit('error', new Error('old error'))).not.toThrow();
    logger.log('STILL ACTIVE'); expect(replacement.write).toHaveBeenCalledWith(expect.stringContaining('STILL ACTIVE'));
    expect(() => replacement.emit('error', new Error('new error'))).not.toThrow();
    replacement.write.mockClear(); logger.log('DISABLED'); expect(replacement.write).not.toHaveBeenCalled();
    expect(replacement.destroy).toHaveBeenCalledOnce(); error.mockRestore();
  });

  it('应该在日志文件夹不存在时创建它', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const logFolder = '/test/logs';
    logger.initialize(logFolder, true);

    expect(fs.mkdirSync).toHaveBeenCalledWith(logFolder, { recursive: true });
  });

  it('omits path and exception text when initialization fails', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => { throw Object.assign(new Error('SYNTHETIC_PATH'), { code: 'EACCES' }); });
    logger.initialize('/SYNTHETIC_PATH/logs', true);
    expect(JSON.stringify(output.mock.calls)).not.toContain('SYNTHETIC');
    expect(output).toHaveBeenCalledWith('Failed to initialize logger:', 'EACCES'); output.mockRestore();
  });
  it('omits synchronous log-write exception bodies and still supports cleanup', () => {
    logger.initialize('/logs', true);
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockWriteStream.write.mockImplementationOnce(() => { throw new Error('SYNTHETIC_DOCUMENT'); });
    logger.log('Safe event'); expect(JSON.stringify(output.mock.calls)).not.toContain('SYNTHETIC');
    logger.cleanup(); expect(mockWriteStream.end).toHaveBeenCalledOnce(); output.mockRestore();
  });
  it('omits asynchronous old-stream error bodies and preserves the replacement stream', () => {
    logger.initialize('/logs/old', true);
    const replacement = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(replacement as unknown as fs.WriteStream);
    logger.initialize('/logs/new', true);
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockWriteStream.emit('error', new Error('SYNTHETIC_OLD_PATH'));
    logger.log('Safe event'); expect(replacement.write).toHaveBeenCalledWith(expect.stringContaining('Safe event'));
    expect(JSON.stringify(output.mock.calls)).not.toContain('SYNTHETIC'); logger.cleanup(); output.mockRestore();
  });
});
