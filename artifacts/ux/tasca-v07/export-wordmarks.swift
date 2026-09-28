import Foundation
import CoreText
import CoreGraphics
import ImageIO

// Uses macOS CoreText; does not register or install fonts system-wide.
let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "artifacts/ux/tasca-v07", isDirectory: true)
let fontURL = root.appendingPathComponent("assets/fonts/GolosText-variable.ttf")
let output = root.appendingPathComponent("assets/wordmarks", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
guard let provider = CGDataProvider(url: fontURL as CFURL), let graphicsFont = CGFont(provider) else {
    fatalError("Cannot read bundled Golos Text font")
}
let base = CTFontCreateWithGraphicsFont(graphicsFont, 1000, nil, nil)
let weightTag = "wght".utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
let descriptor = CTFontDescriptorCreateWithAttributes([
    kCTFontVariationAttribute: [NSNumber(value: weightTag): NSNumber(value: 800)]
] as CFDictionary)
let font = CTFontCreateCopyWithAttributes(base, 1000, nil, descriptor)
let variations = CTFontCopyVariation(font) as? [NSNumber: NSNumber]
precondition(variations?[NSNumber(value: weightTag)]?.intValue == 800, "Font weight must be 800")
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func number(_ value: CGFloat) -> String {
    String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), Double(value))
}

func outline(_ word: String) -> CGPath {
    let attributed = NSAttributedString(string: word, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTKernAttributeName as String): -1000.0 / 35.0
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    let result = CGMutablePath()
    var total = 0
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
        precondition(glyphs.allSatisfy { $0 != 0 }, "Missing glyph")
        for index in 0..<count {
            guard let path = CTFontCreatePathForGlyph(font, glyphs[index], nil) else {
                fatalError("Glyph has no outline")
            }
            result.addPath(path, transform: CGAffineTransform(translationX: positions[index].x, y: positions[index].y))
        }
        total += count
    }
    precondition(total == word.count, "Unexpected glyph shaping")
    return result
}

func pathData(_ path: CGPath) -> String {
    var commands: [String] = []
    path.applyWithBlock { pointer in
        let element = pointer.pointee
        func point(_ index: Int) -> String {
            "\(number(element.points[index].x)) \(number(element.points[index].y))"
        }
        switch element.type {
        case .moveToPoint: commands.append("M\(point(0))")
        case .addLineToPoint: commands.append("L\(point(0))")
        case .addQuadCurveToPoint: commands.append("Q\(point(0)) \(point(1))")
        case .addCurveToPoint: commands.append("C\(point(0)) \(point(1)) \(point(2))")
        case .closeSubpath: commands.append("Z")
        @unknown default: fatalError("Unsupported path element")
        }
    }
    return commands.joined(separator: " ")
}

for (slug, word) in [("tasca-ru", "Таска"), ("tasca-latin", "Tasca")] {
    let path = outline(word)
    let bounds = path.boundingBoxOfPath
    let padding: CGFloat = 32
    let width = bounds.width + padding * 2
    let height = bounds.height + padding * 2
    let data = pathData(path)
    for (variant, color, rgb) in [
        ("green", "#183C2C", [24.0, 60.0, 44.0]),
        ("black", "#000000", [0.0, 0.0, 0.0]),
        ("white", "#FFFFFF", [255.0, 255.0, 255.0])
    ] {
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(number(width)) \(number(height))" role="img" aria-label="\(word)">
          <title>\(word)</title>
          <g transform="translate(\(number(padding - bounds.minX)) \(number(padding + bounds.maxY))) scale(1 -1)">
            <path fill="\(color)" d="\(data)"/>
          </g>
        </svg>
        """
        try svg.write(to: output.appendingPathComponent("\(slug)-\(variant).svg"), atomically: true, encoding: .utf8)
        let scale = 1200.0 / width
        guard let context = CGContext(data: nil, width: 1200, height: Int(ceil(height * scale)), bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            fatalError("Cannot create raster context")
        }
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: padding - bounds.minX, y: padding - bounds.minY)
        context.addPath(path)
        context.setFillColor(CGColor(colorSpace: colorSpace, components: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1])!)
        context.fillPath()
        let pngURL = output.appendingPathComponent("\(slug)-\(variant).png")
        guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(pngURL as CFURL, "public.png" as CFString, 1, nil) else {
            fatalError("Cannot write PNG")
        }
        CGImageDestinationAddImage(destination, image, nil)
        precondition(CGImageDestinationFinalize(destination), "PNG export failed")
        print("EXPORTED \(slug)-\(variant): SVG paths + transparent PNG")
    }
}
print("PASS: native glyph shaping, Cyrillic/Latin coverage, weight 800; no font installation")
