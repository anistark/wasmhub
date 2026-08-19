#!/usr/bin/env bash
# Shared by the runtime build scripts: read a runtime's published feature list
# from its features.txt and print it comma-separated for generate-metadata.sh.
#
# The list lives beside the runtime source so that adding a feature and
# publishing it are the same change. Keeping it in the build script meant the
# script overwrote whatever the manifest said at release time, which is how the
# v0.4.0 manifest came to advertise the v0.3.2 feature set.

read_features() {
    local file="$1"
    if [[ ! -f "${file}" ]]; then
        echo "Error: feature list not found: ${file}" >&2
        return 1
    fi
    # Strip comments and blank lines, then join with commas.
    sed -e 's/#.*//' -e 's/[[:space:]]//g' "${file}" \
        | grep -v '^$' \
        | paste -sd, -
}
