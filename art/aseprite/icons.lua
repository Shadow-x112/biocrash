-- Biocrash icon finishing pass (Aseprite, batch):
--   aseprite -b --script-param src=<raw dir> --script-param dst=<out dir> --script icons.lua
-- Each 128 px render from Blender (art/blender/bc_icons.py) becomes a 64 px pixel-art icon:
-- bilinear down-size, hard alpha (no soft fringe), a 24-colour palette per icon, then a 1 px near-black
-- outline so it reads on any background.
local src, dst = app.params.src, app.params.dst
app.fs.makeAllDirectories(dst)
for _, f in ipairs(app.fs.listFiles(src)) do
  if f:match("%.png$") then
    local spr = app.open(app.fs.joinPath(src, f))
    app.command.SpriteSize{ ui = false, width = 64, height = 64, method = "bilinear" }
    -- Hard-edge the alpha: pixel art has no half-transparent rim.
    local img = spr.cels[1].image:clone()
    for it in img:pixels() do
      local c = it()
      local a = app.pixelColor.rgbaA(c)
      if a < 110 then it(app.pixelColor.rgba(0, 0, 0, 0))
      else it(app.pixelColor.rgba(app.pixelColor.rgbaR(c), app.pixelColor.rgbaG(c), app.pixelColor.rgbaB(c), 255)) end
    end
    spr.cels[1].image = img
    app.command.ColorQuantization{ ui = false, withAlpha = false, maxColors = 24 }
    app.command.ChangePixelFormat{ format = "indexed", dithering = "none" }
    app.command.ChangePixelFormat{ format = "rgb" }
    app.command.Outline{ ui = false, color = Color{ r = 6, g = 8, b = 10, a = 255 }, place = "outside", matrix = "circle" }
    spr:saveAs(app.fs.joinPath(dst, f))
    spr:close()
    print("icon " .. f)
  end
end
