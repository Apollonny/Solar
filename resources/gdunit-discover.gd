extends SceneTree

# App-owned discovery adapter; use the pinned GdUnit4 scanner in the isolated
# snapshot, including inherited and parameterized cases. No live import cache.
func _initialize() -> void:
	call_deferred("_discover")

func _discover() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 2:
		quit(2)
		return
	var selected: Variant = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if not selected is Array:
		quit(2)
		return
	var cases: Array[Dictionary] = []
	var scanner := GdUnitTestSuiteScanner.new()
	for path: String in selected:
		var scripts := scanner.scan("res://" + path)
		if scripts.size() != 1:
			quit(3)
			return
		for test: GdUnitTestCase in GdUnitTestDiscoverer.discover_tests_from_gd_script(scripts[0]):
			cases.append({"path": test.suite_resource_path.trim_prefix("res://"), "name": test.display_name})
	var output := FileAccess.open(args[1], FileAccess.WRITE)
	if output == null:
		quit(4)
		return
	output.store_string(JSON.stringify({"selected": selected, "cases": cases}))
	output.close()
	quit(0)
