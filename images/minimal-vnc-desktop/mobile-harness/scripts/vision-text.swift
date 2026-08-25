#!/usr/bin/env swift
import Foundation
import Vision

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct ImageObservations: Codable {
    let path: String
    let observations: [TextObservation]
}

func recognize(_ path: String) throws -> ImageObservations {
    let url = URL(fileURLWithPath: path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.006
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let observations = (request.results ?? []).compactMap { observation -> TextObservation? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return TextObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            x: box.origin.x,
            y: box.origin.y,
            width: box.size.width,
            height: box.size.height
        )
    }
    return ImageObservations(path: path, observations: observations)
}

do {
    guard CommandLine.arguments.count > 1 else {
        throw NSError(domain: "viewport-vision", code: 2, userInfo: [NSLocalizedDescriptionKey: "Provide at least one screenshot path"])
    }
    let results = try CommandLine.arguments.dropFirst().map { try recognize($0) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(results))
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
