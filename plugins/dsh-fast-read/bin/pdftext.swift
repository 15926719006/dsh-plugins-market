// pdftext — turn a PDF into per-page text, OCR'ing pages that have no text layer.
//
// Usage: pdftext <file.pdf>
// Output: one JSON object per line on stdout.
//   {"type":"meta","title":"...","pages":12}
//   {"type":"page","page":1,"chars":1200,"ocr":false,"text":"..."}
//
// OCR uses Apple's Vision framework with Simplified Chinese and English, which
// is what scanned Chinese books need. A page that already carries text is never
// run through OCR: OCR on a clean text layer is slower and less accurate.

import AppKit
import Foundation
import PDFKit
import Vision

struct MetaLine: Encodable {
    let type = "meta"
    let title: String
    let pages: Int
}

struct PageLine: Encodable {
    let type = "page"
    let page: Int
    let chars: Int
    let ocr: Bool
    let text: String
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

func ocrText(from page: PDFPage) -> String {
    let bounds = page.bounds(for: .mediaBox)
    let width = max(1, bounds.width * 2)
    let height = max(1, bounds.height * 2)
    let image = page.thumbnail(of: NSSize(width: width, height: height), for: .mediaBox)
    var rect = NSRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return "" }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let lines = request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []
    return lines.joined(separator: "\n")
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write("usage: pdftext <file.pdf>\n".data(using: .utf8)!)
    exit(2)
}
let url = URL(fileURLWithPath: arguments[1])
guard let document = PDFDocument(url: url) else {
    FileHandle.standardError.write("cannot open pdf\n".data(using: .utf8)!)
    exit(3)
}
// A locked document answers empty pages; say so instead of OCR'ing blank pages for minutes.
if document.isLocked {
    FileHandle.standardError.write("pdf is locked\n".data(using: .utf8)!)
    exit(4)
}

let title = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String) ?? url.deletingPathExtension().lastPathComponent
emit(MetaLine(title: title, pages: document.pageCount))

for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    var text = page.string ?? ""
    var usedOcr = false
    if text.trimmingCharacters(in: .whitespacesAndNewlines).count < 40 {
        let recognized = ocrText(from: page)
        if recognized.count > text.count {
            text = recognized
            usedOcr = true
        }
    }
    emit(PageLine(page: index + 1, chars: text.count, ocr: usedOcr, text: text))
}
