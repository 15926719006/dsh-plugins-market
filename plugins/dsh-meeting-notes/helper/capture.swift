// dsh-meeting-capture —— 会议纪要插件的双轨采集器。
//
// 用法：capture --out /path/audio.wav [--no-mic] [--no-system]
//
// 输出：一个 16000Hz / 16bit / 2 声道（小端、交错）WAV，边录边追加。
//   ch0（左）= 麦克风（我），ch1（右）= 系统声音（会议里其他人）。
//   系统声 48k 立体声 → 下混单声道 → 重采样 16k；麦克风 48k 单声道 → 重采样 16k。
//   两条轨按同一个时钟推进，缺样本补静音，多出来的留到下一次，保证两轨严格同步。
//
// stdout 每行一个 JSON 事件（NDJSON）：
//   {"event":"started","sampleRate":16000,"channels":2}
//   {"event":"level","mic":0.12,"system":0.31}
//   {"event":"error","message":"..."}
//   {"event":"stopped","durationMs":12345}
//
// 降级：麦克风打不开（没权限/没设备）只录系统轨（ch0 全 0），发 error 事件后继续；
//       系统声打不开说明这台机器没法录音，发 error 事件并以退出码 2 退出。
// 孤儿守卫：每 2 秒看一次父进程，变成 1（DSH 被强杀）就自己收尾退出，不留孤儿进程。

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - 常量

/// 输出采样率，与 whisper 要求的 16k 一致。
let outputSampleRate = 16000
/// 输出声道数：ch0 麦克风、ch1 系统声音。
let outputChannels = 2
/// 每帧字节数（2 声道 × int16）。
let bytesPerFrame = outputChannels * 2
/// 标准 PCM WAV 头长度。
let wavHeaderBytes = 44
/// 同步写盘节拍：50ms 一次，写多少帧由墙上时钟决定。
let tickIntervalMs = 50
/// 电平事件间隔。
let levelIntervalMs = 500
/// 重写 WAV 头的间隔，保证文件随时可被 ffmpeg 读。
let headerIntervalMs = 5000
/// 孤儿检查间隔。
let orphanCheckMs = 2000
/// 停止时最多等 1.2 秒让 stream 收尾，留 0.3 秒余量给「1.5 秒内停完」。
let stopGraceSeconds = 1.2

// MARK: - 错误

/// 采集器内部错误。
enum CaptureError: LocalizedError {
    /// 系统声音（ScreenCaptureKit）不可用，属于致命错误。
    case system(String)
    /// 麦克风不可用，降级继续。
    case microphone(String)
    /// 写文件失败，属于致命错误。
    case output(String)

    var errorDescription: String? {
        switch self {
        case .system(let message), .microphone(let message), .output(let message):
            return message
        }
    }
}

// MARK: - NDJSON 事件

/// 往 stdout 写一行 JSON。写失败（比如父进程已经关了管道）直接忽略，不打断采集。
func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8),
          let bytes = (line + "\n").data(using: .utf8)
    else { return }
    try? FileHandle.standardOutput.write(contentsOf: bytes)
    fflush(stdout)
}

/// 直接写一行已经拼好的 JSON（电平事件用，避免 17 位浮点尾巴）。
func emitRaw(_ line: String) {
    guard let bytes = (line + "\n").data(using: .utf8) else { return }
    try? FileHandle.standardOutput.write(contentsOf: bytes)
    fflush(stdout)
}

/// 发一条 error 事件。
func emitError(_ message: String) {
    emit(["event": "error", "message": message])
}

/// 电平值保留 4 位小数，避免 JSON 里出现 0.088399998843669891 这种噪音。
func roundTo4(_ value: Double) -> Double {
    (value * 10_000).rounded() / 10_000
}

// MARK: - WAV 写入

/// little-endian 追加工具。
func appendUInt16(_ data: inout Data, _ value: UInt16) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
}

/// little-endian 追加工具。
func appendUInt32(_ data: inout Data, _ value: UInt32) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
}

/// 生成 44 字节标准 PCM WAV 头。
/// - Parameter dataBytes: data 块字节数；传 nil 表示长度未知（录制中），写 0xFFFFFFFF 占位。
func wavHeader(dataBytes: UInt32?) -> Data {
    let dataSize = dataBytes ?? 0xFFFF_FFFF
    let riffSize = dataBytes.map { min(36 + $0, 0xFFFF_FFFF) } ?? 0xFFFF_FFFF
    var data = Data(capacity: wavHeaderBytes)
    data.append(contentsOf: Array("RIFF".utf8))
    appendUInt32(&data, riffSize)
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    appendUInt32(&data, 16) // fmt 块大小
    appendUInt16(&data, 1) // PCM
    appendUInt16(&data, UInt16(outputChannels))
    appendUInt32(&data, UInt32(outputSampleRate))
    appendUInt32(&data, UInt32(outputSampleRate * bytesPerFrame)) // 每秒字节数
    appendUInt16(&data, UInt16(bytesPerFrame)) // 块对齐
    appendUInt16(&data, 16) // 位深
    data.append(contentsOf: Array("data".utf8))
    appendUInt32(&data, dataSize)
    return data
}

/// 单文件 WAV 写入器：先写占位头，之后周期性把真实长度写回头部，退出前 finalize。
/// 所有调用都发生在主队列（同步节拍、头部节拍、收尾），所以内部不再加锁。
final class WavWriter {
    private let handle: FileHandle
    private var pending = Data()
    private(set) var frames: UInt64 = 0

    /// 打开（或覆盖）目标文件并落一个长度未知的头。
    init(path: String) throws {
        let url = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: path) {
            do { try FileManager.default.removeItem(at: url) } catch {
                throw CaptureError.output("无法覆盖旧录音文件：\(error.localizedDescription)")
            }
        }
        guard FileManager.default.createFile(atPath: path, contents: nil, attributes: nil) else {
            throw CaptureError.output("无法创建录音文件：\(path)")
        }
        handle = try FileHandle(forWritingTo: url)
        try write(contentsOf: wavHeader(dataBytes: nil))
    }

    /// 追加一段交错 int16 帧数据（先攒着，攒够 32KB 落盘，减少系统调用）。
    func append(_ interleaved: [Int16], frames frameCount: Int) {
        guard !interleaved.isEmpty else { return }
        interleaved.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            base.withMemoryRebound(to: UInt8.self, capacity: buffer.count * 2) { bytes in
                pending.append(bytes, count: buffer.count * 2)
            }
        }
        frames += UInt64(frameCount)
        if pending.count >= 32 * 1024 { flush() }
    }

    /// 把攒着的样本写进文件。
    func flush() {
        guard !pending.isEmpty else { return }
        do {
            try handle.write(contentsOf: pending)
            pending.removeAll(keepingCapacity: true)
        } catch {
            emitError("写录音文件失败：\(error.localizedDescription)")
        }
    }

    /// 刷新并重写头部（把真实长度写回去）。录制中每 5 秒一次，停止时一次。
    func rewriteHeader() {
        flush()
        let dataBytes = UInt64(frames) * UInt64(bytesPerFrame)
        let header = wavHeader(dataBytes: UInt32(min(dataBytes, UInt64(UInt32.max))))
        do {
            try handle.seek(toOffset: 0)
            try handle.write(contentsOf: header)
            try handle.seekToEnd()
        } catch {
            emitError("写 WAV 头失败：\(error.localizedDescription)")
        }
    }

    /// 收尾：落盘、写真头、fsync 并关闭。
    func finish() {
        rewriteHeader()
        do { try handle.synchronize() } catch { /* 失败不影响已写内容 */ }
        try? handle.close()
    }

    private func write(contentsOf data: Data) throws {
        do { try handle.write(contentsOf: data) } catch {
            throw CaptureError.output("写 WAV 头失败：\(error.localizedDescription)")
        }
    }
}

// MARK: - 单轨样本缓冲

/// 一条轨（麦克风 / 系统声）的 16k 单声道样本队列。
/// 音频回调往里塞，主队列按墙上时钟往外抽；不够就补静音，多的留到下次。
final class Track {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var peak: Float = 0
    private(set) var receivedSamples: UInt64 = 0

    /// 音频回调：追加一批 16k 单声道样本，顺便记下这段的峰值。
    func append(_ values: [Float]) {
        guard !values.isEmpty else { return }
        lock.lock()
        for value in values {
            let magnitude = abs(value)
            if magnitude > peak { peak = magnitude }
        }
        samples.append(contentsOf: values)
        receivedSamples += UInt64(values.count)
        // 兜底：万一主队列长时间被卡住，别把内存吃光，只留最近 5 秒。
        let limit = outputSampleRate * 5
        if samples.count > limit { samples.removeFirst(samples.count - limit) }
        lock.unlock()
    }

    /// 从队列头取出 `count` 个样本写进交错缓冲；不足的部分保持原样（静音 0）。
    func drain(count: Int, into interleaved: inout [Int16], channel: Int) {
        lock.lock()
        defer { lock.unlock() }
        let available = min(count, samples.count)
        for index in 0..<available {
            let value = samples[index]
            let clamped = max(-1.0, min(1.0, value))
            interleaved[index * outputChannels + channel] = Int16(clamped * 32767.0)
        }
        if available > 0 { samples.removeFirst(available) }
    }

    /// 取走这一段的峰值并清零（电平事件用）。
    func takePeak() -> Float {
        lock.lock()
        defer { lock.unlock() }
        let value = peak
        peak = 0
        return value
    }

    /// 当前积压的样本数，用于排障。
    func backlog() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count
    }
}

// MARK: - 重采样

/// 把 CMSampleBuffer（系统声 48k 立体声 / 麦克风 48k 单声道）转成 16k 单声道 float 样本。
/// 内部保持一个 AVAudioConverter 复用于后续 buffer，避免每块都重新起滤波器。
final class Resampler {
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    /// 转换一块音频；返回 nil 表示这块跳过了。
    func convert(sampleBuffer: CMSampleBuffer) -> [Float]? {
        guard sampleBuffer.isValid,
              CMSampleBufferGetNumSamples(sampleBuffer) > 0,
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription),
              let source = AVAudioFormat(streamDescription: streamDescription)
        else { return nil }

        // 保留源声道数，重采样后自己下混，避免依赖 AVAudioConverter 的声道映射策略。
        let channels: AVAudioChannelCount = source.channelCount >= 2 ? 2 : 1
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(outputSampleRate),
            channels: channels,
            interleaved: false
        ) else { return nil }

        if converter == nil || sourceFormat != source {
            converter = AVAudioConverter(from: source, to: target)
            converter?.sampleRateConverterQuality = AVAudioQuality.max.rawValue
            sourceFormat = source
        }
        guard let converter else { return nil }

        let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
        let bufferCount = max(1, Int(source.channelCount))
        let audioBufferList = AudioBufferList.allocate(maximumBuffers: bufferCount)
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: bufferCount),
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr,
              let sourceBuffer = AVAudioPCMBuffer(
                  pcmFormat: source,
                  bufferListNoCopy: audioBufferList.unsafeMutablePointer,
                  deallocator: nil
              )
        else { return nil }
        sourceBuffer.frameLength = AVAudioFrameCount(sampleCount)

        let ratio = Double(outputSampleRate) / source.sampleRate
        let capacity = AVAudioFrameCount(Double(sampleCount) * ratio) + 1024
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }

        var conversionError: NSError?
        var supplied = false
        let input = sourceBuffer
        _ = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        if conversionError != nil { return nil }

        let frameCount = Int(outputBuffer.frameLength)
        guard frameCount > 0, let channelData = outputBuffer.floatChannelData else { return nil }

        var values = [Float](repeating: 0, count: frameCount)
        if channels == 1 {
            let mono = channelData[0]
            for index in 0..<frameCount { values[index] = mono[index] }
        } else {
            let left = channelData[0]
            let right = channelData[1]
            for index in 0..<frameCount { values[index] = (left[index] + right[index]) * 0.5 }
        }
        return values
    }
}

// MARK: - 系统声音回调

/// ScreenCaptureKit 的音频输出：抓系统里正在播放的声音（会议里其他人的声音）。
final class SystemAudioSink: NSObject, SCStreamOutput, @unchecked Sendable {
    private let resampler = Resampler()
    weak var mixer: Mixer?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              sampleBuffer.isValid,
              CMSampleBufferGetNumSamples(sampleBuffer) > 0
        else { return }
        guard let values = resampler.convert(sampleBuffer: sampleBuffer) else { return }
        mixer?.systemTrack.append(values)
    }
}

// MARK: - 麦克风回调

/// AVCaptureSession 的音频输出：抓麦克风（我的声音）。
final class MicrophoneSink: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let resampler = Resampler()
    weak var mixer: Mixer?

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid,
              CMSampleBufferGetNumSamples(sampleBuffer) > 0
        else { return }
        guard let values = resampler.convert(sampleBuffer: sampleBuffer) else { return }
        mixer?.microphoneTrack.append(values)
    }
}

// MARK: - 混音 + 时钟

/// 双轨同步器：按墙上时钟算出「此刻应该已经写了多少帧」，把两轨各自的样本按序取出，
/// 缺的补静音，多的留着下次，最后交错写进 WAV。这样两轨永远严格对齐，录音时长也等于真实时长。
final class Mixer {
    let microphoneTrack: Track
    let systemTrack: Track
    private let writer: WavWriter
    private let startedAt: UInt64
    private(set) var framesWritten: UInt64 = 0
    /// 停止开始后同步节拍不再写，最后交给 finalWrite 一次写完。
    var stopped = false

    init(writer: WavWriter) {
        self.writer = writer
        self.microphoneTrack = Track()
        self.systemTrack = Track()
        self.startedAt = DispatchTime.now().uptimeNanoseconds
    }

    /// 距离开始已经过去的帧数。
    var elapsedFrames: UInt64 {
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000_000
        return UInt64(max(0, elapsed) * Double(outputSampleRate))
    }

    /// 50ms 节拍：把这 50ms 要输出的帧补齐。单次最多补 1 秒，避免系统卡顿后一口气爆写。
    func tick() {
        guard !stopped else { return }
        let target = elapsedFrames
        guard target > framesWritten else { return }
        var count = target - framesWritten
        if count > UInt64(outputSampleRate) { count = UInt64(outputSampleRate) }
        writeFrames(count)
    }

    /// 收尾：把从上次节拍到现在的尾巴补完（按真实时长补齐）。
    func finalWrite() {
        stopped = true
        let target = elapsedFrames
        guard target > framesWritten else { return }
        writeFrames(target - framesWritten)
    }

    /// 当前录音时长（毫秒），以已输出的帧数为准。
    var durationMs: Int {
        Int(framesWritten * 1000 / UInt64(outputSampleRate))
    }

    private func writeFrames(_ count: UInt64) {
        guard count > 0 else { return }
        let frameCount = Int(count)
        var interleaved = [Int16](repeating: 0, count: frameCount * outputChannels)
        microphoneTrack.drain(count: frameCount, into: &interleaved, channel: 0)
        systemTrack.drain(count: frameCount, into: &interleaved, channel: 1)
        writer.append(interleaved, frames: frameCount)
        framesWritten += count
    }
}

// MARK: - 命令行参数

/// `capture` 的命令行参数。
struct Options {
    var outPath: String?
    var noMic = false
    var noSystem = false
}

/// 解析命令行参数。
/// - Parameter arguments: 不含程序名的参数列表。
/// - Returns: 解析结果。
func parseArguments(_ arguments: [String]) throws -> Options {
    var options = Options()
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--out":
            index += 1
            guard index < arguments.count else {
                throw CaptureError.system("--out 后面要跟输出文件路径")
            }
            options.outPath = arguments[index]
        case "--no-mic":
            options.noMic = true
        case "--no-system":
            options.noSystem = true
        default:
            throw CaptureError.system("不认识的参数：\(arguments[index])")
        }
        index += 1
    }
    return options
}

// MARK: - 采集器主体

/// 采集器：管两路 stream、同步器、定时器、信号与收尾。
final class Capture: @unchecked Sendable {
    private let options: Options
    private let writer: WavWriter
    private let mixer: Mixer
    private let systemSink = SystemAudioSink()
    private let microphoneSink = MicrophoneSink()
    private let systemSamplesQueue = DispatchQueue(label: "dsh.meeting.capture.system")
    private let microphoneSamplesQueue = DispatchQueue(label: "dsh.meeting.capture.mic.samples")
    private let microphoneSessionQueue = DispatchQueue(label: "dsh.meeting.capture.mic.session")
    /// 采集器的状态队列：定时器、WAV 写入、收尾、信号处理都在这条串行队列上，
    /// 不用主队列 —— 命令行程序里 RunLoop.main 不会排空主队列，dispatch 定时器不会触发。
    private let stateQueue = DispatchQueue(label: "dsh.meeting.capture.state")
    private static let stateQueueKey = DispatchSpecificKey<UInt8>()
    private var timers: [DispatchSourceTimer] = []
    private var signalSources: [DispatchSourceSignal] = []
    private var stream: SCStream?
    private var microphoneSession: AVCaptureSession?
    private var stopRequested = false
    private var finished = false

    /// 建好写入器并接上两条轨。
    init(options: Options) throws {
        guard let outPath = options.outPath else {
            throw CaptureError.output("缺少 --out 参数")
        }
        self.options = options
        self.writer = try WavWriter(path: outPath)
        self.mixer = Mixer(writer: writer)
        systemSink.mixer = mixer
        microphoneSink.mixer = mixer
        stateQueue.setSpecific(key: Capture.stateQueueKey, value: 1)
    }

    /// 启动：装定时器、装信号处理，然后异步拉起两路采集。
    func begin() {
        timers.append(makeTimer(intervalMs: tickIntervalMs) { [weak self] in
            self?.mixer.tick()
        })
        timers.append(makeTimer(intervalMs: levelIntervalMs) { [weak self] in
            self?.emitLevel()
        })
        timers.append(makeTimer(intervalMs: headerIntervalMs) { [weak self] in
            self?.writer.rewriteHeader()
        })
        timers.append(makeTimer(intervalMs: orphanCheckMs) { [weak self] in
            self?.checkOrphan()
        })

        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: number, queue: stateQueue)
            source.setEventHandler { [weak self] in
                self?.requestStop(reason: "收到停止信号")
            }
            source.resume()
            signalSources.append(source)
        }

        Task { [self] in
            await boot()
        }
    }

    // MARK: 启动

    /// 先把系统声拉起来（关键轨），成功后才发 started；麦克风随后异步拉，失败只降级。
    private func boot() async {
        if !options.noSystem {
            do {
                try await startSystemCapture()
            } catch {
                emitError("系统声音采集失败：\(error.localizedDescription)")
                exit(2)
            }
        }
        emit(["event": "started", "sampleRate": outputSampleRate, "channels": outputChannels])

        if options.noMic {
            emitError("已指定 --no-mic，ch0（麦克风）保持静音")
            return
        }
        await startMicrophone()
    }

    /// 用 ScreenCaptureKit 抓系统声音。没有「屏幕与系统音频录制」权限或没有显示器都会失败。
    private func startSystemCapture() async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw CaptureError.system("拿不到可采集内容（检查「屏幕与系统音频录制」权限）：\(error.localizedDescription)")
        }
        guard let display = content.displays.first else {
            throw CaptureError.system("没有可用的显示器，无法抓系统声音")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        // 必须关掉「排除本进程声音」：实测（macOS 15.5 / M4 Pro）开着它时，采集器启动前就已经在播的
        // 声音会全部变成静音（SCK 只把启动之后新出现的音频流算进来），而真实会议里会议软件的声音
        // 早在点「开始记录」之前就在播了。采集器自己不播任何声音，关掉不会有回声风险。
        configuration.excludesCurrentProcessAudio = false
        configuration.sampleRate = 48000
        configuration.channelCount = 2
        // 只要音频，视频参数压到最小，减少无谓开销。
        configuration.width = 32
        configuration.height = 32
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        configuration.queueDepth = 8

        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        try stream.addStreamOutput(systemSink, type: .audio, sampleHandlerQueue: systemSamplesQueue)
        self.stream = stream
        try await stream.startCapture()
    }

    /// 拉麦克风：没权限或没设备就降级成只录系统声，ch0 全 0，不退出。
    private func startMicrophone() async {
        var authorized = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            authorized = await AVCaptureDevice.requestAccess(for: .audio)
        }
        guard authorized else {
            emitError("麦克风没有权限，只录对方的声音（ch0 静音）")
            return
        }
        guard AVCaptureDevice.default(for: .audio) != nil else {
            emitError("没有可用的麦克风，只录对方的声音（ch0 静音）")
            return
        }
        do {
            try startMicrophoneSession()
        } catch {
            emitError("麦克风打不开，只录对方的声音（ch0 静音）：\(error.localizedDescription)")
        }
    }

    /// 在独立队列上建 AVCaptureSession 并 startRunning（startRunning 会阻塞，不能占主线程）。
    private func startMicrophoneSession() throws {
        let session = AVCaptureSession()
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw CaptureError.microphone("没有可用的麦克风设备")
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CaptureError.microphone("无法把麦克风接入采集会话")
        }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(microphoneSink, queue: microphoneSamplesQueue)
        guard session.canAddOutput(output) else {
            throw CaptureError.microphone("无法接入音频输出")
        }
        session.addOutput(output)

        microphoneSession = session
        microphoneSessionQueue.async {
            session.startRunning()
        }
    }

    // MARK: 电平 / 孤儿

    /// 每 500ms 报一次两轨峰值，UI 用来判断「有没有声音进来」。
    private func emitLevel() {
        let mic = roundTo4(Double(mixer.microphoneTrack.takePeak()))
        let system = roundTo4(Double(mixer.systemTrack.takePeak()))
        // 固定 4 位小数、POSIX 小数点，别让 JSONSerialization 打出 0.088400000000000006。
        let line = String(
            format: "{\"event\":\"level\",\"mic\":%.4f,\"system\":%.4f}",
            locale: Locale(identifier: "en_US_POSIX"),
            mic,
            system
        )
        emitRaw(line)
    }

    /// 父进程变成 1 说明 DSH 被强杀了，自己收尾退出，别留孤儿。
    private func checkOrphan() {
        if getppid() == 1 {
            requestStop(reason: "父进程已退出")
        }
    }

    // MARK: 停止

    /// 停止采集：先停两路 stream，再让状态队列收尾（头部 + stopped 事件 + exit）。
    /// 整体 1.5 秒内完成，兜底看门狗保证不超过 1.2 秒。
    func requestStop(reason: String) {
        guard !stopRequested else { return }
        stopRequested = true
        mixer.stopped = true
        _ = reason

        stateQueue.asyncAfter(deadline: .now() + stopGraceSeconds) { [weak self] in
            self?.finish()
        }
        Task { [self] in
            if let stream {
                try? await stream.stopCapture()
            }
            let session = microphoneSession
            microphoneSessionQueue.async {
                session?.stopRunning()
            }
            onState { [self] in finish() }
        }
    }

    /// 收尾：停定时器 → 补完尾巴 → 刷新头部 → 打印 stopped → 退出。重复调用无副作用。
    private func finish() {
        onState { [self] in
            guard !finished else { return }
            finished = true
            for timer in timers { timer.cancel() }
            timers.removeAll()
            for source in signalSources { source.cancel() }
            signalSources.removeAll()

            mixer.finalWrite()
            writer.finish()
            emit(["event": "stopped", "durationMs": mixer.durationMs])
            exit(0)
        }
    }

    /// 保证一段状态操作在状态队列上执行（已经在队列上就直接跑，避免自锁）。
    private func onState(_ block: @escaping () -> Void) {
        if DispatchQueue.getSpecific(key: Capture.stateQueueKey) != nil {
            block()
        } else {
            stateQueue.sync(execute: block)
        }
    }

    /// 造一个跑在状态队列上的重复定时器。
    private func makeTimer(intervalMs: Int, handler: @escaping () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        let interval = DispatchTimeInterval.milliseconds(intervalMs)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler(handler: handler)
        timer.resume()
        return timer
    }
}

// MARK: - 入口

/// 全局持有采集器：main() 交给 dispatchMain 后栈帧不再使用局部变量，
/// 没有这个强引用 ARC 会提前释放采集器，定时器和信号源随之失效。
nonisolated(unsafe) var activeCapture: Capture?

/// 程序入口（配合 `-parse-as-library` 用 `@main`）。
@main
struct CaptureMain {
    static func main() {
        let options: Options
        do {
            options = try parseArguments(Array(CommandLine.arguments.dropFirst()))
        } catch {
            emitError("参数错误：\(error.localizedDescription)")
            exit(64)
        }

        do {
            activeCapture = try Capture(options: options)
            activeCapture?.begin()
        } catch {
            emitError(error.localizedDescription)
            exit(1)
        }

        // 状态队列管定时器与收尾；主线程交给 dispatchMain 常驻，实际退出由 finish() 里的 exit(0) 负责。
        dispatchMain()
    }
}
