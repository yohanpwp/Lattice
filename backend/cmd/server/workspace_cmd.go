package main

import (
	"fmt"

	"github.com/pocketbase/pocketbase"
	"github.com/spf13/cobra"

	"github.com/Lattice/backend/internal/platform/authz"
)

func registerWorkspaceCommands(app *pocketbase.PocketBase) {
	workspaceCmd := &cobra.Command{
		Use:   "workspace",
		Short: "Manage workspace security and operator tasks",
	}

	setupTokenCmd := &cobra.Command{
		Use:   "setup-token",
		Short: "Generate or print the one-time owner setup token",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := app.Bootstrap(); err != nil {
				return err
			}
			token, err := authz.GetOrCreateSetupToken(app)
			if err != nil {
				return fmt.Errorf("could not generate setup token: %w", err)
			}
			fmt.Printf("Workspace Setup Token (valid 24h): %s\n", token)
			return nil
		},
	}

	var recoverEmail, recoverPassword string
	recoverCmd := &cobra.Command{
		Use:   "recover-owner",
		Short: "Recover or promote a workspace owner account directly via operator CLI",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := app.Bootstrap(); err != nil {
				return err
			}
			if recoverEmail == "" || len(recoverPassword) < 8 {
				return fmt.Errorf("--email and --password (min 8 chars) are required")
			}
			owner, err := authz.RecoverOwner(app, recoverEmail, recoverPassword)
			if err != nil {
				return fmt.Errorf("failed to recover owner: %w", err)
			}
			fmt.Printf("Successfully recovered workspace owner: %s (id: %s)\n", owner.GetString("email"), owner.Id)
			return nil
		},
	}
	recoverCmd.Flags().StringVar(&recoverEmail, "email", "", "Email address of the owner account")
	recoverCmd.Flags().StringVar(&recoverPassword, "password", "", "New password for the owner account")

	workspaceCmd.AddCommand(setupTokenCmd, recoverCmd)
	app.RootCmd.AddCommand(workspaceCmd)
}
