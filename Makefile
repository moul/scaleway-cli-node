.PHONY: binaries


binaries: node_modules
	# npm install -g enclose
	enclose -x -o ./bin/scw-$(shell uname -s)-$(shell uname -m)  ./bin/scw


node_modules:
	npm install
