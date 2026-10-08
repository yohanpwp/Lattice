// Package secrets provides private, injectable access to runtime secrets.
// Secret values must never be copied into public config, feature options or events.
package secrets

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// ErrNotFound marks a configured secret that is absent from its selected store.
var ErrNotFound = errors.New("secret not found")

// Store retrieves a secret by its canonical identifier.
type Store interface {
	Get(ctx context.Context, name string) (string, error)
}

// EmptyStore keeps existing registry callers independent of configured secret
// providers until an enabled plugin explicitly requests a value.
type EmptyStore struct{}

func (EmptyStore) Get(_ context.Context, name string) (string, error) {
	if err := validateName(name); err != nil {
		return "", err
	}
	return "", fmt.Errorf("secret %s: %w", name, ErrNotFound)
}

// Closer is implemented by stores that own resources across lookups.
type Closer interface {
	Close() error
}

var identifierPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

func validateName(name string) error {
	if !identifierPattern.MatchString(name) {
		return fmt.Errorf("invalid secret identifier %q", name)
	}
	return nil
}

// EnvStore reads only LATTICE_SECRET_<NAME> environment variables.
type EnvStore struct {
	LookupEnv func(string) (string, bool)
}

func (s EnvStore) Get(ctx context.Context, name string) (string, error) {
	if err := validateName(name); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("secret lookup canceled: %w", err)
	}
	lookup := s.LookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	value, ok := lookup("LATTICE_SECRET_" + name)
	if !ok || value == "" {
		return "", fmt.Errorf("secret %s: %w", name, ErrNotFound)
	}
	return value, nil
}

// FileStore reads a secret from a regular file directly under its resolved root.
// Symlink entries are rejected to keep identifiers from escaping the root.
type FileStore struct {
	root     string
	openFile func(string) (*os.File, error)
}

func NewFileStore(root string) (*FileStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve secret directory: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("resolve secret directory: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("inspect secret directory: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("secret directory is not a directory")
	}
	return &FileStore{root: resolved, openFile: os.Open}, nil
}

func (s *FileStore) Get(ctx context.Context, name string) (string, error) {
	if err := validateName(name); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("secret lookup canceled: %w", err)
	}
	path := filepath.Join(s.root, name)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("secret %s: %w", name, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("inspect secret %s: %w", name, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("secret %s must be a regular file, not a symlink", name)
	}

	openFile := s.openFile
	if openFile == nil {
		openFile = os.Open
	}
	file, err := openFile(path)
	if err != nil {
		return "", fmt.Errorf("open secret %s: %w", name, err)
	}
	openedInfo, statErr := file.Stat()
	if statErr != nil {
		_ = file.Close()
		return "", fmt.Errorf("inspect opened secret %s: %w", name, statErr)
	}
	currentInfo, lstatErr := os.Lstat(path)
	if lstatErr != nil || currentInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, openedInfo) || !os.SameFile(openedInfo, currentInfo) {
		_ = file.Close()
		return "", fmt.Errorf("secret %s changed during lookup", name)
	}
	value, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil {
		return "", fmt.Errorf("read secret %s: %w", name, readErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close secret %s: %w", name, closeErr)
	}
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("secret lookup canceled: %w", err)
	}
	if len(value) == 0 {
		return "", fmt.Errorf("secret %s: %w", name, ErrNotFound)
	}
	return string(value), nil
}

// Close satisfies Closer. FileStore closes every opened file during Get.
func (s *FileStore) Close() error { return nil }

// NewConfigured selects mounted files when SECRETS_DIR is set; otherwise it
// uses environment variables. A selected file store never falls back to env.
func NewConfigured(lookup func(string) (string, bool)) (Store, error) {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	if dir, ok := lookup("SECRETS_DIR"); ok && dir != "" {
		return NewFileStore(dir)
	}
	return EnvStore{LookupEnv: lookup}, nil
}
