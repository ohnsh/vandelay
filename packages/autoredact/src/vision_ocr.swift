import Foundation
import Vision
import AppKit

struct WordBox: Codable {
    let text: String
    let bbox: [Double] // [x, y, w, h] normalized 0..1 in full frame (top-left origin)
}

struct LineObservation: Codable {
    let quadrant: String // "TL", "TR", or "FULL"
    let text: String
    let confidence: Float
    let bbox: [Double] // [x, y, w, h] normalized 0..1 in full frame (top-left origin)
    let words: [WordBox]
}

struct FaceObservation: Codable {
    let quadrant: String
    let confidence: Float
    let bbox: [Double] // [x, y, w, h] normalized 0..1 in full frame (top-left origin)
}

struct ImageOCRResult: Codable {
    let path: String
    let width: Int
    let height: Int
    let elapsedMs: Double
    let lines: [LineObservation]
    let faces: [FaceObservation]
}

func runVisionRequests(
    on cgImage: CGImage,
    quadrant: String,
    offsetX: Double,
    offsetY: Double,
    scaleX: Double,
    scaleY: Double,
    fastMode: Bool
) -> ([LineObservation], [FaceObservation]) {
    var lines: [LineObservation] = []
    var faces: [FaceObservation] = []

    let textRequest = VNRecognizeTextRequest { request, _ in
        guard let observations = request.results as? [VNRecognizedTextObservation] else { return }

        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let fullText = candidate.string
            let rect = obs.boundingBox
            let lx = Double(rect.origin.x)
            let ly = Double(1.0 - rect.origin.y - rect.size.height)
            let lw = Double(rect.size.width)
            let lh = Double(rect.size.height)

            let gx = offsetX + lx * scaleX
            let gy = offsetY + ly * scaleY
            let gw = lw * scaleX
            let gh = lh * scaleY

            var wordBoxes: [WordBox] = []
            let nsString = fullText as NSString
            nsString.enumerateSubstrings(in: NSRange(location: 0, length: nsString.length), options: .byWords) { word, wordRange, _, _ in
                guard let word = word,
                      let stringRange = Range(wordRange, in: fullText),
                      let boxObs = try? candidate.boundingBox(for: stringRange) else { return }
                let wr = boxObs.boundingBox
                let wx = offsetX + Double(wr.origin.x) * scaleX
                let wy = offsetY + Double(1.0 - wr.origin.y - wr.size.height) * scaleY
                let ww = Double(wr.size.width) * scaleX
                let wh = Double(wr.size.height) * scaleY
                wordBoxes.append(WordBox(text: word, bbox: [wx, wy, ww, wh]))
            }

            lines.append(LineObservation(
                quadrant: quadrant,
                text: fullText,
                confidence: candidate.confidence,
                bbox: [gx, gy, gw, gh],
                words: wordBoxes
            ))
        }
    }

    textRequest.recognitionLevel = fastMode ? .fast : .accurate
    textRequest.usesLanguageCorrection = false

    let faceRequest = VNDetectFaceRectanglesRequest { request, _ in
        guard let observations = request.results as? [VNFaceObservation] else { return }
        for obs in observations {
            let rect = obs.boundingBox
            let lx = Double(rect.origin.x)
            let ly = Double(1.0 - rect.origin.y - rect.size.height)
            let lw = Double(rect.size.width)
            let lh = Double(rect.size.height)

            let gx = offsetX + lx * scaleX
            let gy = offsetY + ly * scaleY
            let gw = lw * scaleX
            let gh = lh * scaleY

            faces.append(FaceObservation(
                quadrant: quadrant,
                confidence: obs.confidence,
                bbox: [gx, gy, gw, gh]
            ))
        }
    }

    let includeVisionFaces = CommandLine.arguments.contains("--vision-faces")
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    if includeVisionFaces {
        try? handler.perform([textRequest, faceRequest])
    } else {
        try? handler.perform([textRequest])
    }
    return (lines, faces)
}

func recognizeImage(path: String, quadTop: Bool, fastMode: Bool) -> ImageOCRResult? {
    let t0 = CFAbsoluteTimeGetCurrent()
    let url = URL(fileURLWithPath: path)
    guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
        return nil
    }
    let width = cgImage.width
    let height = cgImage.height

    var allLines: [LineObservation] = []
    var allFaces: [FaceObservation] = []

    if quadTop {
        let halfW = width / 2
        let halfH = height / 2
        var tlLines: [LineObservation] = []
        var trLines: [LineObservation] = []
        var tlFaces: [FaceObservation] = []
        var trFaces: [FaceObservation] = []
        let group = DispatchGroup()

        if let tlImage = cgImage.cropping(to: CGRect(x: 0, y: 0, width: halfW, height: halfH)) {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let (l, f) = runVisionRequests(on: tlImage, quadrant: "TL", offsetX: 0.0, offsetY: 0.0, scaleX: 0.5, scaleY: 0.5, fastMode: fastMode)
                tlLines = l
                tlFaces = f
                group.leave()
            }
        }
        if let trImage = cgImage.cropping(to: CGRect(x: halfW, y: 0, width: halfW, height: halfH)) {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let (l, f) = runVisionRequests(on: trImage, quadrant: "TR", offsetX: 0.5, offsetY: 0.0, scaleX: 0.5, scaleY: 0.5, fastMode: fastMode)
                trLines = l
                trFaces = f
                group.leave()
            }
        }
        group.wait()
        allLines.append(contentsOf: tlLines)
        allLines.append(contentsOf: trLines)
        allFaces.append(contentsOf: tlFaces)
        allFaces.append(contentsOf: trFaces)
    } else {
        let (l, f) = runVisionRequests(on: cgImage, quadrant: "FULL", offsetX: 0.0, offsetY: 0.0, scaleX: 1.0, scaleY: 1.0, fastMode: fastMode)
        allLines.append(contentsOf: l)
        allFaces.append(contentsOf: f)
    }

    let elapsedMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
    return ImageOCRResult(path: path, width: width, height: height, elapsedMs: elapsedMs, lines: allLines, faces: allFaces)
}

let fastMode = CommandLine.arguments.contains("--fast")
let quadTop = !CommandLine.arguments.contains("--full")
let args = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("--") }

var results = Array<ImageOCRResult?>(repeating: nil, count: args.count)
DispatchQueue.concurrentPerform(iterations: args.count) { idx in
    results[idx] = recognizeImage(path: args[idx], quadTop: quadTop, fastMode: fastMode)
}

let validResults = results.compactMap { $0 }
let encoder = JSONEncoder()
if let data = try? encoder.encode(validResults), let jsonStr = String(data: data, encoding: .utf8) {
    print(jsonStr)
}
