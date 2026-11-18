local out = os.getenv("TEXMFOUTPUT")
local function link(target, name)
  if not out or not lfs.link then
    texio.write_nl("term and log", "CORPUS-PROBE link " .. name .. ": failed (no TEXMFOUTPUT or lfs.link)")
    return
  end
  local ok, r, err = pcall(lfs.link, target, out .. "/" .. name, true)
  if ok and r then
    texio.write_nl("term and log", "CORPUS-PROBE link " .. name .. ": CREATED")
  else
    texio.write_nl("term and log", "CORPUS-PROBE link " .. name .. ": failed (" .. tostring(err or r) .. ")")
  end
end
link("@LINK_TARGET_1@", "output.pdf")
link("@LINK_TARGET_2@", "output.synctex.gz")
link("@LINK_TARGET_DIR@", "chapters")
