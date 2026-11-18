-- Case 4 probes, loaded by main.tex. Results: "refused", "RAN", "WROTE", "READ", "LISTED".
-- Contents that were read are never printed (the test also checks no marker leaks).
local function say(label, result)
  texio.write_nl("term and log", "CORPUS-PROBE " .. label .. ": " .. result)
end

local function try(label, f)
  local ok, r = pcall(f)
  if not ok then
    say(label, "refused (error: " .. string.gsub(tostring(r), "[\r\n]", " ") .. ")")
  elseif r then
    say(label, r)
  else
    say(label, "refused")
  end
end

-- Running programs: all of these need shell escape, which is off (shell_escape=f).
try("os.execute", function()
  local r = os.execute("touch @PWNED@")
  if r ~= nil and r ~= false then return "RAN" end
end)
try("io.popen", function()
  local p = io.popen("echo corpus-popen")
  if p then local s = p:read("*a"); p:close(); if s and #s > 0 then return "RAN" end end
end)
try("os.spawn", function()
  if not os.spawn then return nil end
  local r = os.spawn({ "touch", "@PWNED@" })
  if r ~= nil and r ~= false then return "RAN" end
end)

-- Writing outside the project: openout_any=p.
try("write-absolute", function()
  local f = io.open("@PWNED_WRITE@", "w")
  if f then f:write("pwned"); f:close(); return "WROTE" end
end)
try("write-dotdot", function()
  local f = io.open("../../pwned-lua.txt", "w")
  if f then f:write("pwned"); f:close(); return "WROTE" end
end)

-- Reading outside the project. kpathsea's openin_any does NOT reliably restrict Lua's io library, so
-- only the OS boundary (uid sandbox: 0700 dirs of other uids, root-only files) protects these.
local function read(label, path)
  try(label, function()
    local f = io.open(path, "r")
    if f then local s = f:read("*a"); f:close(); if s then return "READ" end end
  end)
end
read("read-etc-passwd", "/etc/passwd")
read("read-world-readable-secret", "@SECRET@")
read("read-private-secret", "@PRIVATE@")
read("read-other-project", "@BUILDS@/@OTHER@/src/secret.tex")
read("read-blob-cache", "@BLOB@")
read("read-worker-environ", "/proc/@WORKER_PID@/environ")
try("list-builds-dir", function()
  local n = 0
  for name in lfs.dir("@BUILDS@") do n = n + 1 end
  if n > 0 then return "LISTED" end
end)

-- Network: LuaTeX only loads luasocket with shell escape. (In production the container has no network either.)
try("socket", function()
  local ok, socket = pcall(require, "socket")
  if not ok or type(socket) ~= "table" or not socket.tcp then return nil end
  local c = socket.tcp()
  c:settimeout(2)
  if c:connect("127.0.0.1", @PORT@) then c:close(); return "CONNECTED" end
  return "LOADED"
end)

-- Climbing out with relative lfs.chdir(".."): LuaTeX refuses absolute chdir and "../" paths (openout_any),
-- but not ".." on its own, and every later RELATIVE open/mkdir is checked against the new cwd. So a document
-- can walk to "/" and back down into any directory it can enter, and write wherever its uid may write.
-- Only the OS boundary stops this: the uid sandbox (no write permission) and no world-writable directories.
local function parts(p)
  local t = {}
  for s in string.gmatch(p, "[^/\\]+") do t[#t + 1] = s end
  if t[1] and string.match(t[1], "^%a:$") then table.remove(t, 1) end -- Windows drive
  return t
end
local home = lfs.currentdir()
local homeParts = parts(home)
local function cd(d) local ok, r = pcall(lfs.chdir, d); return ok and r end
local function toRoot() for _ = 1, #homeParts + 2 do cd("..") end end
local function into(t) local n = 0; for _, c in ipairs(t) do if not cd(c) then break end; n = n + 1 end; return n end
-- Runs f with the cwd at dir (reached only through relative chdirs); always returns to the project.
local function climbing(dir, f)
  toRoot()
  local t = parts(dir)
  local ok, r = true, nil
  if into(t) == #t then ok, r = pcall(f) end
  toRoot()
  into(homeParts)
  if not ok then error(r, 0) end
  return r
end
try("climb-up", function()
  local r = climbing("/", function() return lfs.currentdir() ~= home and "CLIMBED" or nil end)
  if lfs.currentdir() ~= home then return "LOST" end
  return r
end)
for _, target in ipairs(@CLIMB_TARGETS@) do
  local name, dir = target[1], target[2]
  try("climb-write " .. name, function()
    return climbing(dir, function()
      local f = io.open("@CLIMB_FILE@", "w")
      if f then f:write("pwned"); f:close(); return "WROTE" end
    end)
  end)
  try("climb-mkdir " .. name, function()
    return climbing(dir, function()
      if lfs.mkdir("@CLIMB_FILE@.d") then return "MKDIR" end
    end)
  end)
end
if lfs.currentdir() ~= home then say("climb-restore", "LOST " .. lfs.currentdir()) end

-- Last: os.exec would replace the TeX process if it were allowed.
try("os.exec", function()
  if not os.exec then return nil end
  local r = os.exec({ "touch", "@PWNED@" })
  if r ~= nil and r ~= false then return "RAN" end
end)
