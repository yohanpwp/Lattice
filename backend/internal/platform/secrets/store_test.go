package secrets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvStoreReadsCanonicalNameAndReturnsSafeNotFound(t *testing.T) {
	store := EnvStore{LookupEnv: func(key string) (string, bool) {
		if key == "LATTICE_SECRET_PAYMENT_API_KEY" {
			return "private-value", true
		}
		return "", false
	}}
	got, err := store.Get(context.Background(), "PAYMENT_API_KEY")
	if err != nil || got != "private-value" {
		t.Fatalf("Get() = %q, %v", got, err)
	}
	_, err = store.Get(context.Background(), "MISSING")
	if !errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("missing lookup error = %v", err)
	}
}

func TestFileStoreReadsOnlyDirectRegularFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "PAYMENT_API_KEY"), []byte("private-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "DIRECTORY"), 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), "PAYMENT_API_KEY")
	if err != nil || got != "private-value" {
		t.Fatalf("Get() = %q, %v", got, err)
	}
	if _, err := store.Get(context.Background(), "../outside"); err == nil {
		t.Fatal("path traversal name was accepted")
	}
	if _, err := store.Get(context.Background(), "MISSING"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing file error = %v", err)
	}
	if _, err := store.Get(context.Background(), "DIRECTORY"); err == nil {
		t.Fatal("directory secret was accepted as a file")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Get(ctx, "PAYMENT_API_KEY"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled file lookup error = %v", err)
	}

}

func TestFileStoreRejectsSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside-secret")
	if err := os.WriteFile(outside, []byte("outside-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "OUTSIDE")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("platform does not allow symlink test: %v", err)
	}
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), "OUTSIDE"); err == nil || strings.Contains(err.Error(), "outside-value") {
		t.Fatalf("symlink escape was accepted or value leaked: %v", err)
	}
}

func TestFileStoreSurfacesUnreadableAndCanceledLookups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "UNREADABLE")
	if err := os.WriteFile(path, []byte("private-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	store.openFile = func(string) (*os.File, error) { return nil, errors.New("permission denied") }
	if _, err := store.Get(context.Background(), "UNREADABLE"); err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("unreadable lookup error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Get(ctx, "UNREADABLE"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled file lookup error = %v", err)
	}
}

func TestConfiguredStoreSelectsOneProviderWithoutFallback(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "FROM_FILE"), []byte("file-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	lookup := func(key string) (string, bool) {
		if key == "SECRETS_DIR" {
			return dir, true
		}
		if key == "LATTICE_SECRET_FROM_FILE" {
			return "env-value", true
		}
		if key == "LATTICE_SECRET_ONLY_IN_ENV" {
			return "must-not-fallback", true
		}
		return "", false
	}
	store, err := NewConfigured(lookup)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), "FROM_FILE")
	if err != nil || got != "file-value" {
		t.Fatalf("file provider selection = %q, %v", got, err)
	}
	_, err = store.Get(context.Background(), "ONLY_IN_ENV")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("file provider fell back to env: %v", err)
	}
}

func TestSecretLookupsRejectCanceledContextsAndNeverReturnValuesInErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := EnvStore{LookupEnv: func(string) (string, bool) { return "private-value", true }}
	_, err := store.Get(ctx, "PAYMENT_API_KEY")
	if !errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("canceled lookup error = %v", err)
	}
}
