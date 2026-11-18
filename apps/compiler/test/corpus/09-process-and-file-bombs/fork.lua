local started = 0
for i = 1, 500 do
  local ok, p = pcall(io.popen, "sleep 120")
  if ok and p then started = started + 1 end
  local ok2, r = pcall(os.execute, "sleep 120 &")
  if ok2 and r ~= nil and r ~= false then started = started + 1 end
  if os.spawn then
    local ok3, r3 = pcall(os.spawn, { "sleep", "120" })
    if ok3 and r3 ~= nil and r3 ~= false then started = started + 1 end
  end
end
texio.write_nl("term and log", "CORPUS-PROBE fork-started: " .. started)
