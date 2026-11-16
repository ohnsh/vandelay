import Foundation
import AppKit

let directory = CommandLine.arguments[1]
let scenarios: [(String, [(String, Int, Int)])] = [
    ("clean", [("Project notes", 40, 60), ("Implement exports and review documentation", 40, 110)]),
    ("env", [(".env.production", 40, 440),
             ("DATABASE_URL=postgres://demo:synthetic-password@localhost/db", 40, 490),
             ("CLOUDFLARE_API_TOKEN=synthetic_cf_0123456789abcdefgh", 40, 540),
             ("VERCEL_TOKEN=synthetic_vercel_0123456789abcdefgh", 40, 590)]),
    ("dashboard", [("Cloudflare / My Profile / API Tokens", 40, 60),
                   ("Your API token was created", 40, 110),
                   ("API Token", 40, 400),
                   ("0123456789abcdef0123456789abcdef01234567", 40, 450)]),
    ("vercel", [("Vercel / Settings / Tokens", 40, 60),
                ("Token", 40, 400),
                ("syntheticVercel0123456789abcdefgh", 40, 450)]),
    ("small", [(".env", 40, 500), ("API_KEY=synthetic_small_0123456789", 40, 550)]),
]
for (name, lines) in scenarios {
    let image = NSImage(size: NSSize(width: 1280, height: 800))
    image.lockFocus()
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: 1280, height: 800).fill()
    for (text, x, y) in lines {
        (text as NSString).draw(at: NSPoint(x: x, y: 800 - y - 30), withAttributes: [
            .font: NSFont.monospacedSystemFont(ofSize: name == "small" ? 14 : 25, weight: .regular),
            .foregroundColor: NSColor.black
        ])
    }
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory + "/" + name + ".png"))
}
