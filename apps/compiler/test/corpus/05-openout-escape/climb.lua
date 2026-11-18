-- Case 5d helpers: move the cwd out of the project with relative lfs.chdir("..") only (absolute chdir is
-- refused), as in 04-lua-escape/probe.lua, so that a later \openout of a relative name would land there.
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

-- Paths are filled in here, not in the .tex: TeX would expand characters like ~ in an argument of \directlua.
local targets = { ww = "@CLIMB_WW@", locked = "@CLIMB_LOCKED@" }

function corpus_climb(name)
  toRoot()
  local t = parts(targets[name])
  local ok = into(t) == #t
  texio.write_nl("term and log", "CORPUS-PROBE climb " .. name .. ": " .. (ok and "IN" or "refused"))
end

function corpus_home()
  toRoot()
  into(homeParts)
  texio.write_nl("term and log", "CORPUS-PROBE home: " .. (lfs.currentdir() == home and "ok" or "LOST"))
end
