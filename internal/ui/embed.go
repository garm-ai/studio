// Package ui carries the built Studio bundle into the binary.
//
// The bundle is a build artifact and is git-ignored; `mise run ui` builds it
// from web/ into THIS package's dist/ — `//go:embed` can only see files
// under the embedding package's own directory. What IS committed is
// internal/ui/dist/.gitkeep, and the embed pattern is `all:dist` for exactly
// that file: `//go:embed dist` refuses to compile a directory whose only
// file is a dot-file ("contains no embeddable files"), and a Go-only
// checkout — one that never ran npm — has to build. `all:` is therefore not
// an escape hatch for a half-built bundle; it is what lets an EMPTY one
// compile, and Assets is what refuses to serve it.
//
// A missing bundle is an error from Assets rather than a binary that serves
// an empty page: the caller decides whether that is fatal, and it should be
// in any deployment that means to serve Studio.
package ui

import (
	"embed"
	"errors"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// ErrNoBundle is what Assets returns when dist holds no index.html: the
// checkout never ran `mise run ui`, or the build failed before writing it.
var ErrNoBundle = errors.New("ui: the embedded bundle holds no index.html; run `mise run ui`")

// Assets returns the bundle rooted at dist/, so a request for /assets/app.js
// finds dist/assets/app.js without every caller knowing the prefix.
func Assets() (fs.FS, error) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, ErrNoBundle
	}
	return sub, nil
}
