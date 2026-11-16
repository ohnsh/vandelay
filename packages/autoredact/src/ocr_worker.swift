import Foundation
import Vision
import ImageIO

struct Request: Decodable { let path: String; let scrutiny: Bool }
struct Line: Encodable { let text: String; let box: [Double]; let confidence: Float }
struct Response: Encodable {
    var lines: [Line] = []
    var width = 0
    var height = 0
    var error: String? = nil
}

func recognize(_ image: CGImage, rect: CGRect) throws -> [Line] {
    let width = Double(image.width), height = Double(image.height)
    let pixels = CGRect(x: rect.minX * width, y: rect.minY * height,
                        width: rect.width * width, height: rect.height * height).integral
    guard let crop = image.cropping(to: pixels) else { throw NSError(domain: "crop", code: 1) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: crop, options: [:]).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let b = observation.boundingBox
        return Line(text: candidate.string,
                    box: [(pixels.minX + b.minX * pixels.width) / width,
                          (pixels.minY + (1 - b.maxY) * pixels.height) / height,
                          b.width * pixels.width / width, b.height * pixels.height / height],
                    confidence: candidate.confidence)
    }
}

// One request at a time; no source text or native errors on stderr.
while let input = readLine() {
    let response: Response = autoreleasepool {
        do {
            let request = try JSONDecoder().decode(Request.self, from: Data(input.utf8))
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: request.path) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  image.width > 0, image.height > 0,
                  image.width <= 16384, image.height <= 16384,
                  image.width * image.height <= 40_000_000 else {
                return Response(error: "image-decode-or-size-limit")
            }
            var lines: [Line] = []
            if request.scrutiny {
                // Overlapping crops preserve boundary text while presenting smaller
                // text to Vision at a larger fraction of the image dimensions.
                for y in [0.0, 0.4] {
                    for x in [0.0, 0.4] {
                        lines += try recognize(image, rect: CGRect(x: x, y: y, width: 0.6, height: 0.6))
                    }
                }
            } else {
                lines = try recognize(image, rect: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            return Response(lines: lines, width: image.width, height: image.height)
        } catch {
            return Response(error: "ocr-failed")
        }
    }
    let data = try! JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
