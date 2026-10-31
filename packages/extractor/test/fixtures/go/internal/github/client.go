package github

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

const apiBase = "https://api.github.com"

type Workflow struct {
	ID    int64  `json:"id"`
	State string `json:"state"`
	Owner User   `json:"owner,omitempty"`
}

type User struct {
	Login string `json:"login"`
}

type workflowList struct {
	TotalCount int        `json:"total_count"`
	Workflows  []Workflow `json:"workflows"`
}

func Dispatch(owner, repo, workflow string) error {
	url := fmt.Sprintf("%s/repos/%s/%s/actions/workflows/%s/dispatches", apiBase, owner, repo, workflow)
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("GITHUB_TOKEN"))
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("dispatch: %s", resp.Status)
	}
	return nil
}

func ActiveWorkflows(owner, repo string) ([]Workflow, error) {
	resp, err := http.Get(apiBase + "/repos/" + owner + "/" + repo + "/actions/workflows?per_page=100")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 || resp.StatusCode == 403 {
		return nil, nil
	}
	remaining := resp.Header.Get("X-RateLimit-Remaining")
	_ = remaining
	var list workflowList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, err
	}
	var out []Workflow
	for _, w := range list.Workflows {
		if w.State == "active" {
			out = append(out, w)
		}
	}
	return out, nil
}

func Me(client *http.Client, token string) (string, error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	req.Header.Add("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	body, _ := io.ReadAll(resp.Body)
	var me struct {
		Login string `json:"login"`
		Plan  struct {
			Name string `json:"name"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(body, &me); err != nil {
		return "", err
	}
	return me.Login, nil
}
