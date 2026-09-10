// Cuts the main subject out of a photo into a transparent PNG using macOS Vision.
// Works best on a photo already cropped around the subject.
//   npm run cutout -- input.jpg images/output.png
import Foundation
import Vision
import CoreImage
import AppKit

let args = CommandLine.arguments
guard args.count >= 3, let input = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else { print("usage: cutout in out"); exit(1) }
let handler = VNImageRequestHandler(ciImage: input, options: [:])
let req = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([req])
guard let res = req.results?.first, !res.allInstances.isEmpty else { print("no foreground found"); exit(2) }
let buf = try res.generateMaskedImage(ofInstances: res.allInstances, from: handler, croppedToInstancesExtent: true)
let cut = CIImage(cvPixelBuffer: buf)
let pad = max(cut.extent.width, cut.extent.height) * 0.08
let canvas = CGRect(x: 0, y: 0, width: cut.extent.width + 2 * pad, height: cut.extent.height + 2 * pad)
let placed = cut.transformed(by: CGAffineTransform(translationX: pad - cut.extent.minX, y: pad - cut.extent.minY))
let out = placed.composited(over: CIImage(color: .clear).cropped(to: canvas)).cropped(to: canvas)
let ctx = CIContext()
guard let cg = ctx.createCGImage(out, from: canvas) else { print("render failed"); exit(3) }
let rep = NSBitmapImageRep(cgImage: cg)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(4) }
try png.write(to: URL(fileURLWithPath: args[2]))
print("wrote \(Int(canvas.width))x\(Int(canvas.height))")
