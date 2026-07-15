package main

import (
	"strings"
	"testing"
)

func TestValidateExtractionWithTEEXPathText(t *testing.T) {
	resp := validateExtractionWithTEE(reclaimValidateExtractionRequest{
		ResponseBody:  `<div id="global"><ul><li>John Doe</li></ul></div>`,
		ExpectedValue: "John Doe",
		XPath:         `//div[@id="global"]/ul/li/text()[1]`,
		Regex:         `(?<fullName>.+)`,
	})
	if !resp.Valid {
		t.Fatalf("expected valid extraction, got error: %v; steps: %v", derefString(resp.Error), resp.Steps)
	}
	if !resp.TEEValid {
		t.Fatalf("expected TEEValid=true")
	}
	if resp.ExtractedValue == nil || *resp.ExtractedValue != "John Doe" {
		t.Fatalf("expected extracted value %q, got %v", "John Doe", derefString(resp.ExtractedValue))
	}
	if resp.Error != nil {
		t.Fatalf("expected nil error, got %q", *resp.Error)
	}
}

func TestValidateExtractionWithTEERequiresSelector(t *testing.T) {
	resp := validateExtractionWithTEE(reclaimValidateExtractionRequest{
		ResponseBody:  `{"name":"John Doe"}`,
		ExpectedValue: "John Doe",
	})
	if resp.Valid {
		t.Fatalf("expected invalid extraction when no selector is provided")
	}
	if resp.Error == nil {
		t.Fatalf("expected an error message")
	}
	if want := "Expected either xPath, jsonPath or regex"; !strings.Contains(*resp.Error, want) {
		t.Fatalf("expected error to contain %q, got %q", want, *resp.Error)
	}
}

func derefString(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
